import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openDatabase } from '../index/db.js'
import { call as daemonCall, isDaemonReachable } from './client.js'
import { createHandlers, type Handlers } from './handlers.js'
import { getMcpUrlPath } from './paths.js'
import {
  encodeMessage,
  MessageDecoder,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol.js'
import { startMcpHttp, type HttpListener } from '../mcp/http.js'
import { createWatcher, type WatcherHandle } from './watcher.js'
import {
  createDebouncer,
  createWriterQueue,
  type Debouncer,
  type WriterQueue,
} from './watcherQueue.js'
import {
  createExtractionPool,
  defaultExtractionPoolSize,
  type ExtractionPool,
} from './extractionPool.js'
import { upsertTextBlob } from '../index/textBlobs.js'

export type CreateServerOptions = {
  socketPath: string
  dbPath?: string
  pidPath?: string
  // When provided + non-empty, the daemon spins up a chokidar watcher on
  // these directories and live-indexes mutations through the
  // extraction pool + writer queue. Slice 3 ship bar: any file mutation
  // is searchable via mm_find within 5 seconds.
  // Omitted (or empty array) → no watcher is constructed; the daemon
  // serves whatever is already in the DB. This keeps every existing
  // test that does not need a watcher from paying the build-dist cost.
  roots?: string[]
}

export type DaemonServer = {
  socketPath: string
  close: () => Promise<void>
}

export async function createServer(opts: CreateServerOptions): Promise<DaemonServer> {
  fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true })

  // Pid file is the cheapest liveness check; honor it before touching the
  // socket so we never even probe in the common "another mmd is up" case.
  if (opts.pidPath && fs.existsSync(opts.pidPath)) {
    const raw = fs.readFileSync(opts.pidPath, 'utf8').trim()
    const pid = Number(raw)
    if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
      throw new Error(`another mmd is running (pid ${pid}); pid file: ${opts.pidPath}`)
    }
    // Stale pid file (dead process or unparseable). Safe to remove.
    fs.unlinkSync(opts.pidPath)
  }

  if (fs.existsSync(opts.socketPath)) {
    // If something's actually listening, refuse to start. Stealing the socket
    // would orphan the previous daemon and leave the user with two writers.
    const reachable = await isDaemonReachable(opts.socketPath)
    if (reachable) {
      throw new Error(`another daemon is already listening on ${opts.socketPath}`)
    }
    fs.unlinkSync(opts.socketPath)
  }

  let db: Database.Database | null = null
  let server: net.Server | null = null
  const sockets = new Set<net.Socket>()
  try {
    db = openDatabase(opts.dbPath)
    const handlers = createHandlers({ db, startedAt: Date.now() })

    server = net.createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachConnection(socket, handlers)
    })
    const boundServer = server
    await new Promise<void>((resolve, reject) => {
      boundServer.once('error', reject)
      boundServer.listen(opts.socketPath, () => {
        boundServer.off('error', reject)
        try {
          fs.chmodSync(opts.socketPath, 0o600)
        } catch (cause) {
          reject(cause)
          return
        }
        resolve()
      })
    })

    if (opts.pidPath) {
      try {
        fs.writeFileSync(opts.pidPath, String(process.pid))
      } catch (cause) {
        throw new Error(
          `failed to write pid file at ${opts.pidPath}: ${(cause as Error).message}`,
        )
      }
    }
  } catch (cause) {
    // Any failure after we opened the db, bound the socket, or wrote the pid
    // file must leave the same clean state — no zombie listener, no stale
    // socket, no leaked db handle, no orphan pid file.
    await teardownPartial(server, db, opts.socketPath, opts.pidPath)
    throw cause
  }

  let httpListener: HttpListener | null = null
  try {
    httpListener = await startMcpHttp({
      daemon: {
        call: <R = unknown>(method: string, params: unknown): Promise<R> =>
          daemonCall<R>(opts.socketPath, method, params),
      },
      urlPath: getMcpUrlPath(),
    })
  } catch (cause) {
    // HTTP failure tears down the rest exactly like other post-bind setup.
    await teardownPartial(server, db, opts.socketPath, opts.pidPath)
    throw new Error(`mcp http failed to start: ${(cause as Error).message}`)
  }

  // Live-indexing pipeline: only constructed when scan roots are
  // provided. createExtractionPool() throws if dist/ isn't built —
  // tests that don't pass roots avoid this dependency.
  let pool: ExtractionPool | null = null
  let writerQueue: WriterQueue | null = null
  let debouncer: Debouncer | null = null
  let watcher: WatcherHandle | null = null
  let watcherErrorCount = 0
  if (opts.roots && opts.roots.length > 0) {
    try {
      pool = createExtractionPool({ size: defaultExtractionPoolSize() })
      const liveDbForQueue = db
      writerQueue = createWriterQueue({
        runTransaction: work => liveDbForQueue.transaction(work)(),
      })
      const livePool = pool
      const liveQueue = writerQueue
      debouncer = createDebouncer({
        onJob: job => {
          if (job.kind === 'delete') {
            // Basic delete: Task 6 will replace this with the inode-paired
            // version + 1s grace window. For Task 5 we just hard-delete so
            // the live path stays correct for the simple unlink case.
            liveQueue.push({
              path: job.path,
              apply: () => {
                applyDeleteByPath(liveDbForQueue, job.path)
              },
            })
            return
          }
          const stat = safeStat(job.path)
          if (!stat) return
          // runImageOcr: image policy lives on the main thread; the worker
          // executes. Slice 3 keeps the existing scanner default (off for
          // the live path; the scanner's screenshot detection runs at scan
          // time only). Task 6 / Slice 5 may revisit this.
          livePool.extract(job.path, { runImageOcr: false })
            .then(result => {
              liveQueue.push({
                path: job.path,
                apply: () => {
                  applyExtractionResult(liveDbForQueue, job.path, opts.roots![0]!, stat, result)
                },
              })
            })
            .catch(err => {
              // Worker pool errors are observable but not fatal — Task 5
              // step 5 wires the degraded counter into the watcher error
              // path; pool errors land here for now. Increment the same
              // counter so a sustained failure mode shows up via _status.
              watcherErrorCount++
              process.stderr.write(`mmd: pool extract failed for ${job.path}: ${(err as Error).message}\n`)
            })
        },
      })
      const liveDebouncer = debouncer
      watcher = createWatcher({
        roots: opts.roots,
        onEvent: ev => {
          if (ev.kind === 'error') {
            watcherErrorCount++
            process.stderr.write(`mmd: watcher error: ${ev.error.message}\n`)
            return
          }
          liveDebouncer.enqueue(ev)
        },
      })
      await watcher.ready
    } catch (cause) {
      // Any failure in pipeline construction unwinds everything we built
      // here so the caller gets a clean error.
      try { await watcher?.close() } catch { /* ignore */ }
      debouncer?.clear()
      try { await pool?.close() } catch { /* ignore */ }
      writerQueue?.close()
      try { await httpListener.close() } catch { /* ignore */ }
      await teardownPartial(server, db, opts.socketPath, opts.pidPath)
      throw new Error(`watcher pipeline failed to start: ${(cause as Error).message}`)
    }
  }

  const liveServer = server
  const liveDb = db
  const liveHttp = httpListener
  const livePool2 = pool
  const liveQueue2 = writerQueue
  const liveDebouncer2 = debouncer
  const liveWatcher = watcher
  return {
    socketPath: opts.socketPath,
    close: async () => {
      // 6-step shutdown ordering per Slice 3 plan Task 5 Step 2:
      // 1. Stop watcher (no new events arrive)
      if (liveWatcher) {
        try { await liveWatcher.close() } catch { /* ignore */ }
      }
      // 2. Drain debouncer (pending timers fire into the pool)
      if (liveDebouncer2) liveDebouncer2.flushAll()
      // 3. Drain pool (in-flight extractions land in the writer queue)
      if (livePool2) {
        try { await livePool2.close() } catch { /* ignore */ }
      }
      // 4. Drain writer queue (final transactions commit)
      if (liveQueue2) {
        try { await liveQueue2.flush() } catch { /* ignore */ }
        liveQueue2.close()
      }
      // 5. Close HTTP listener (existing path with closeAllConnections).
      try {
        await liveHttp.close()
      } catch {
        /* ignore */
      }
      // 6. Force-close stragglers + close DB + remove pid + socket files.
      await new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        liveServer.close(() => {
          liveDb.close()
          if (fs.existsSync(opts.socketPath)) {
            try {
              fs.unlinkSync(opts.socketPath)
            } catch {
              /* ignore */
            }
          }
          if (opts.pidPath && fs.existsSync(opts.pidPath)) {
            try {
              fs.unlinkSync(opts.pidPath)
            } catch {
              /* ignore */
            }
          }
          resolve()
        })
      })
    },
  }
}

// Live-path apply functions. These mirror what scanFiles' Pass B does
// for one file, scoped down so the watcher pipeline can call them
// without dragging in fast-glob or batch logic.

function safeStat(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath) } catch { return null }
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

type ExtractionResultShape = {
  text: { success: boolean; content: string | null; extractorType: string | null } | null
  image: { mimeType: string | null; isImage: boolean; isScreenshot: boolean; raw: Record<string, unknown>; summaryText: string | null } | null
  ocr: { success: boolean; content: string | null; extractorType: string | null } | null
}

function applyExtractionResult(
  db: Database.Database,
  filePath: string,
  root: string,
  stat: fs.Stats,
  result: ExtractionResultShape,
): void {
  const id = stableId(filePath)
  const insert = db.prepare(`
    INSERT INTO file_records (
      id, path, name, extension, mime_type, size_bytes, created_at, modified_at, accessed_at, source_root, metadata_json
    ) VALUES (
      @id, @path, @name, @extension, @mime_type, @size_bytes, @created_at, @modified_at, @accessed_at, @source_root, @metadata_json
    )
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name, extension=excluded.extension, mime_type=excluded.mime_type,
      size_bytes=excluded.size_bytes, modified_at=excluded.modified_at, accessed_at=excluded.accessed_at,
      source_root=excluded.source_root, metadata_json=excluded.metadata_json
  `)
  insert.run({
    id,
    path: filePath,
    name: path.basename(filePath),
    extension: path.extname(filePath).replace('.', ''),
    mime_type: result.image?.mimeType ?? null,
    size_bytes: stat.size,
    created_at: new Date(stat.birthtimeMs || Date.now()).toISOString(),
    modified_at: new Date(stat.mtimeMs || Date.now()).toISOString(),
    accessed_at: new Date(stat.atimeMs || Date.now()).toISOString(),
    source_root: root,
    metadata_json: JSON.stringify({
      lastIndexedAt: new Date().toISOString(),
      isImage: result.image?.isImage ?? false,
      ...(result.image?.raw ?? {}),
    }),
  })
  if (result.text?.success && result.text.content && result.text.extractorType) {
    upsertTextBlob(db, {
      sourceId: id,
      sourceType: 'file',
      extractorType: result.text.extractorType,
      content: result.text.content,
    })
  }
  if (result.image?.summaryText) {
    upsertTextBlob(db, {
      sourceId: id,
      sourceType: 'file',
      extractorType: result.image.raw.isScreenshot === true ? 'screenshot_metadata' : 'image_metadata',
      content: result.image.summaryText,
    })
  }
  if (result.ocr?.success && result.ocr.content && result.ocr.extractorType) {
    upsertTextBlob(db, {
      sourceId: id,
      sourceType: 'file',
      extractorType: result.ocr.extractorType,
      content: result.ocr.content,
    })
  }
}

function applyDeleteByPath(db: Database.Database, filePath: string): void {
  // Three-table delete order from Slice 3 plan Task 6: FTS first, then
  // text_blobs, then file_records. Same transaction (we're inside the
  // writer queue's runTransaction wrapper).
  const id = stableId(filePath)
  db.prepare(`DELETE FROM text_blobs_fts WHERE source_id = ? AND source_type = 'file'`).run(id)
  db.prepare(`DELETE FROM text_blobs WHERE source_id = ? AND source_type = 'file'`).run(id)
  db.prepare(`DELETE FROM file_records WHERE id = ?`).run(id)
}

async function teardownPartial(
  server: net.Server | null,
  db: Database.Database | null,
  socketPath: string,
  pidPath: string | undefined,
): Promise<void> {
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }
  if (pidPath && fs.existsSync(pidPath)) {
    try {
      fs.unlinkSync(pidPath)
    } catch {
      /* ignore */
    }
  }
  // Mid-startup failures must not leave a stale discovery file behind. The
  // path resolves off MM_DATA_DIR (a process-wide env var), so it's safe to
  // recompute here without piping the path through every caller.
  const mcpUrlPath = getMcpUrlPath()
  if (fs.existsSync(mcpUrlPath)) {
    try {
      fs.unlinkSync(mcpUrlPath)
    } catch {
      /* ignore */
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isDaemonRequest(message: unknown): message is DaemonRequest {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return (
    typeof m.method === 'string' &&
    typeof m.id === 'string' &&
    m.result === undefined &&
    m.error === undefined
  )
}

function attachConnection(socket: net.Socket, handlers: Handlers): void {
  const decoder = new MessageDecoder()
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
    let messages
    try {
      messages = decoder.push(text)
    } catch (cause) {
      socket.write(encodeMessage(errorResponse(null, -32700, (cause as Error).message)))
      return
    }
    for (const message of messages) {
      if (!isDaemonRequest(message)) {
        socket.write(encodeMessage(errorResponse(null, -32600, 'invalid request')))
        continue
      }
      socket.write(encodeMessage(dispatch(message, handlers)))
    }
  })

  socket.on('error', err => {
    console.error('mmd: socket error:', err.message)
  })
}

function dispatch(req: DaemonRequest, handlers: Handlers): DaemonResponse {
  const handler = (handlers as unknown as Record<string, (params: unknown) => unknown>)[req.method]
  if (!handler) return errorResponse(req.id, -32601, `method not found: ${req.method}`)
  try {
    return { id: req.id, result: handler(req.params ?? {}) }
  } catch (cause) {
    return errorResponse(req.id, -32000, (cause as Error).message)
  }
}

function errorResponse(id: string | null, code: number, message: string): DaemonResponse {
  return { id, error: { code, message } }
}
