# Phase 1 Slice 1: Daemon Skeleton + Unix Socket IPC

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` discipline for every task: write the failing test first, then the minimal code, then commit.

**Goal:** Stand up `mmd` as a long-running process that listens on a Unix socket and serves `mm_find` / `mm_get` / `mm_recent` / `_ping` over a tiny NDJSON protocol. Rewrite the human CLI so `mm find` / `mm show` transparently delegate to the daemon when it's up and fall through to direct DB access when it's not. No watcher, no MCP, no installer in this slice.

**Architecture:** Daemon is a Node `net` Unix-socket server in-process — no fork/detach logic, no daemonization tricks. Slice 4 hands lifecycle to systemd. Wire format is newline-delimited JSON shaped like JSON-RPC (`{id, method, params}` ↔ `{id, result|error}`); Slice 2 swaps this transport for the real MCP protocol from the same handler layer underneath. Existing `findMatches()`, `openDatabase()`, and the `runShow` data shape are reused as-is — the daemon is a thin RPC over functions that already work.

**Tech Stack:** TypeScript, Node.js (`node:net`, `node:child_process`, `node:crypto`), better-sqlite3, vitest, commander. No new runtime dependencies.

**Reference docs read before writing this plan:**
- `docs/23-product-v2-architecture.md` §3, §4.6, §4.7 (system shape + MCP/CLI surface)
- `docs/22-phase-2-research.md` §3 (`mm_find`/`mm_get` schemas — Slice 2 will use these verbatim)
- `src/cli/main.ts`, `src/cli/commands/{find,show}.ts`, `src/search/find.ts`, `src/types.ts`, `src/index/db.ts`, `src/config/{paths,defaults}.ts`

**Ship bar:** `mm find "<q>"` returns byte-identical results whether the daemon is up or down. `mm daemon status` truthfully reports running/stopped/stale-pid. `mm daemon stop` terminates the process cleanly. All existing tests still pass.

**Out of scope (do not creep):**
- chokidar watcher, worker-pool extraction (Slice 3)
- MCP wire protocol (Slice 2)
- systemd unit file, `npx machine-memory init` (Slice 4)
- structured logging beyond `console.error`
- daemon authentication beyond Unix-socket file permissions (`0600`)

---

## Task 1: Daemon path resolution

**Why:** Every other task needs to know where the socket and PID file live. Centralizing path resolution now means tests can override paths via env without monkey-patching.

**Files:**
- Create: `src/daemon/paths.ts`
- Create: `tests/unit/daemon/paths.test.ts`

**Step 1: Write the failing test**

```ts
// tests/unit/daemon/paths.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { getDaemonPidPath, getDaemonSocketPath } from '../../../src/daemon/paths.js'

describe('daemon paths', () => {
  const originalDataDir = process.env.MM_DATA_DIR
  beforeEach(() => { delete process.env.MM_DATA_DIR })
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MM_DATA_DIR
    else process.env.MM_DATA_DIR = originalDataDir
  })

  it('defaults socket and pid under XDG data dir', () => {
    const expectedDir = path.join(os.homedir(), '.local', 'share', 'machine-memory')
    expect(getDaemonSocketPath()).toBe(path.join(expectedDir, 'mmd.sock'))
    expect(getDaemonPidPath()).toBe(path.join(expectedDir, 'mmd.pid'))
  })

  it('honors MM_DATA_DIR override', () => {
    process.env.MM_DATA_DIR = '/tmp/mm-test-paths'
    expect(getDaemonSocketPath()).toBe('/tmp/mm-test-paths/mmd.sock')
    expect(getDaemonPidPath()).toBe('/tmp/mm-test-paths/mmd.pid')
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/daemon/paths.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement minimal code**

```ts
// src/daemon/paths.ts
import path from 'node:path'
import { getDefaultDataDir } from '../config/defaults.js'

function dataDir(): string {
  return process.env.MM_DATA_DIR ?? getDefaultDataDir()
}

export function getDaemonSocketPath(): string {
  return path.join(dataDir(), 'mmd.sock')
}

export function getDaemonPidPath(): string {
  return path.join(dataDir(), 'mmd.pid')
}
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run tests/unit/daemon/paths.test.ts`
Expected: PASS, 2 tests.

**Step 5: Commit**

```bash
git add src/daemon/paths.ts tests/unit/daemon/paths.test.ts
git commit -m "feat(daemon): add socket and pid path resolution

Centralizes mmd socket and pid-file path resolution under the existing
XDG data dir, with MM_DATA_DIR env override so tests can isolate.
First file in src/daemon/ — sets the module home for the rest of
Slice 1."
```

---

## Task 2: NDJSON wire protocol

**Why:** The daemon and client need a shared framing layer. Newline-delimited JSON because (a) trivially debuggable with `nc -U` + `cat`, (b) Slice 2's MCP transport replaces this layer cleanly, (c) no extra dependency.

**Files:**
- Create: `src/daemon/protocol.ts`
- Create: `tests/unit/daemon/protocol.test.ts`

**Step 1: Write the failing test**

```ts
// tests/unit/daemon/protocol.test.ts
import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageDecoder, type DaemonRequest, type DaemonResponse } from '../../../src/daemon/protocol.js'

describe('NDJSON protocol', () => {
  it('encodes a request as one JSON line ending in newline', () => {
    const req: DaemonRequest = { id: 'abc', method: 'mm_find', params: { query: 'thesis' } }
    const encoded = encodeMessage(req)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(encoded.trim())).toEqual(req)
  })

  it('decodes a single complete message', () => {
    const decoder = new MessageDecoder()
    const messages = decoder.push('{"id":"x","result":[]}\n')
    expect(messages).toEqual<DaemonResponse[]>([{ id: 'x', result: [] }])
  })

  it('buffers partial messages until newline arrives', () => {
    const decoder = new MessageDecoder()
    expect(decoder.push('{"id":"x","resu')).toEqual([])
    expect(decoder.push('lt":[]}\n')).toEqual([{ id: 'x', result: [] }])
  })

  it('decodes multiple messages in one chunk', () => {
    const decoder = new MessageDecoder()
    const messages = decoder.push('{"id":"a","result":1}\n{"id":"b","result":2}\n')
    expect(messages).toEqual([
      { id: 'a', result: 1 },
      { id: 'b', result: 2 },
    ])
  })

  it('throws on malformed JSON, leaving the remaining buffer intact', () => {
    const decoder = new MessageDecoder()
    expect(() => decoder.push('not-json\n')).toThrow(/parse/i)
    // After the throw, a subsequent valid message should still parse:
    expect(decoder.push('{"id":"y","result":true}\n')).toEqual([
      { id: 'y', result: true },
    ])
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/daemon/protocol.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement minimal code**

```ts
// src/daemon/protocol.ts
export type DaemonRequest<P = unknown> = {
  id: string
  method: string
  params?: P
}

export type DaemonResponse<R = unknown> = {
  id: string
  result?: R
  error?: { code: number; message: string; data?: unknown }
}

export type DaemonMessage = DaemonRequest | DaemonResponse

export function encodeMessage(message: DaemonMessage): string {
  return `${JSON.stringify(message)}\n`
}

export class MessageDecoder {
  private buffer = ''

  push(chunk: string): DaemonMessage[] {
    this.buffer += chunk
    const messages: DaemonMessage[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        try {
          messages.push(JSON.parse(line) as DaemonMessage)
        } catch (cause) {
          throw new Error(`failed to parse daemon message: ${(cause as Error).message}`)
        }
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
    return messages
  }
}
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run tests/unit/daemon/protocol.test.ts`
Expected: PASS, 5 tests.

**Step 5: Commit**

```bash
git add src/daemon/protocol.ts tests/unit/daemon/protocol.test.ts
git commit -m "feat(daemon): add NDJSON request/response framing

Tiny line-delimited JSON protocol shaped like JSON-RPC. The daemon
server and CLI client share this codec. Slice 2 replaces the transport
with MCP proper but keeps the same handler dispatch underneath."
```

---

## Task 3: Method dispatcher (handlers over existing search/find code)

**Why:** Pure-function handler layer that's testable without sockets and reusable when Slice 2 mounts MCP on top. `mm_find`, `mm_get`, `mm_recent`, `_ping` map directly to existing functions or simple SQL.

**Files:**
- Create: `src/daemon/handlers.ts`
- Create: `tests/unit/daemon/handlers.test.ts`

**Step 1: Write the failing test**

```ts
// tests/unit/daemon/handlers.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { openDatabase } from '../../../src/index/db.js'
import { createHandlers, type Handlers } from '../../../src/daemon/handlers.js'
import { findMatches } from '../../../src/search/find.js'
import type Database from 'better-sqlite3'

function tempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-handlers-'))
  const dbPath = path.join(dir, 'test.sqlite')
  const db = openDatabase(dbPath)
  return {
    db,
    cleanup: () => {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function seedFile(db: Database.Database, id: string, name: string, modifiedAt: string): void {
  db.prepare(
    `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(id, `/tmp/${name}`, name, name.split('.').pop() ?? '', 'text/plain', modifiedAt, '/tmp')
}

describe('daemon handlers', () => {
  let ctx: ReturnType<typeof tempDb>
  let handlers: Handlers
  beforeEach(() => {
    ctx = tempDb()
    handlers = createHandlers({ db: ctx.db, startedAt: Date.now() - 1000 })
    seedFile(ctx.db, 'f1', 'thesis-intro.md', '2026-04-18T10:00:00Z')
    seedFile(ctx.db, 'f2', 'unrelated.txt', '2026-04-19T10:00:00Z')
  })
  afterEach(() => ctx.cleanup())

  it('mm_find returns the same shape as findMatches direct', () => {
    const direct = findMatches(ctx.db, 'thesis')
    const viaHandler = handlers.mm_find({ query: 'thesis' })
    expect(viaHandler).toEqual(direct)
  })

  it('mm_get returns file record with text blobs', () => {
    const result = handlers.mm_get({ id: 'f1' })
    expect(result).toEqual({
      kind: 'file',
      record: expect.objectContaining({ id: 'f1', name: 'thesis-intro.md' }),
      blobs: [],
    })
  })

  it('mm_get returns null when id is unknown', () => {
    expect(handlers.mm_get({ id: 'nope' })).toBeNull()
  })

  it('mm_recent returns files in modified_at desc order', () => {
    const recent = handlers.mm_recent({ limit: 5 })
    expect(recent.map(r => r.resultId)).toEqual(['f2', 'f1'])
  })

  it('mm_recent honors since filter', () => {
    const recent = handlers.mm_recent({ since: '2026-04-19T00:00:00Z' })
    expect(recent.map(r => r.resultId)).toEqual(['f2'])
  })

  it('_ping returns ok with pid and uptime', () => {
    const ping = handlers._ping()
    expect(ping.ok).toBe(true)
    expect(ping.pid).toBe(process.pid)
    expect(ping.uptime_ms).toBeGreaterThanOrEqual(1000)
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/daemon/handlers.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement minimal code**

```ts
// src/daemon/handlers.ts
import type Database from 'better-sqlite3'
import { findMatches } from '../search/find.js'
import type { SearchResult } from '../types.js'

export type FindParams = { query: string }
export type GetParams = { id: string }
export type RecentParams = { since?: string; limit?: number }

export type GetResult =
  | { kind: 'file'; record: Record<string, unknown>; blobs: BlobSnippet[] }
  | { kind: 'repo'; record: Record<string, unknown>; blobs: BlobSnippet[] }
  | null

export type BlobSnippet = { extractor_type: string; snippet: string }

export type PingResult = { ok: true; pid: number; uptime_ms: number; version: string }

export type Handlers = {
  mm_find: (params: FindParams) => SearchResult[]
  mm_get: (params: GetParams) => GetResult
  mm_recent: (params: RecentParams) => SearchResult[]
  _ping: () => PingResult
}

export type HandlerContext = {
  db: Database.Database
  startedAt: number
  version?: string
}

export function createHandlers(ctx: HandlerContext): Handlers {
  return {
    mm_find: ({ query }) => findMatches(ctx.db, query),
    mm_get: ({ id }) => loadRecord(ctx.db, id),
    mm_recent: ({ since, limit }) => loadRecent(ctx.db, since, limit),
    _ping: () => ({
      ok: true,
      pid: process.pid,
      uptime_ms: Date.now() - ctx.startedAt,
      version: ctx.version ?? '0.1.0',
    }),
  }
}

function loadRecord(db: Database.Database, id: string): GetResult {
  const fileRow = db
    .prepare(
      `SELECT id, path, name, extension, mime_type, modified_at, source_root, metadata_json
       FROM file_records WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined

  const repoRow = fileRow
    ? undefined
    : (db
        .prepare(
          `SELECT id, root_path, repo_name, remote_url, current_branch, last_commit_at
           FROM repo_records WHERE id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined)

  if (!fileRow && !repoRow) return null

  const blobs = db
    .prepare(
      `SELECT extractor_type, substr(content, 1, 160) AS snippet
       FROM text_blobs WHERE source_id = ? ORDER BY extractor_type ASC`,
    )
    .all(id) as BlobSnippet[]

  return fileRow
    ? { kind: 'file', record: fileRow, blobs }
    : { kind: 'repo', record: repoRow!, blobs }
}

function loadRecent(
  db: Database.Database,
  since: string | undefined,
  limit: number | undefined,
): SearchResult[] {
  const cap = Math.min(Math.max(limit ?? 20, 1), 100)
  const sinceClause = since ? 'WHERE modified_at >= ?' : ''
  const params = since ? [since, cap] : [cap]
  const rows = db
    .prepare(
      `SELECT id, path, name, modified_at
       FROM file_records ${sinceClause}
       ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(...params) as Array<{ id: string; path: string; name: string; modified_at: string | null }>
  return rows.map(row => ({
    resultId: row.id,
    resultType: 'file' as const,
    title: row.name,
    path: row.path,
    whyMatched: 'Recently modified',
    score: 0,
    lastModified: row.modified_at ?? undefined,
  }))
}
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run tests/unit/daemon/handlers.test.ts`
Expected: PASS, 6 tests.

**Step 5: Commit**

```bash
git add src/daemon/handlers.ts tests/unit/daemon/handlers.test.ts
git commit -m "feat(daemon): add handler layer over findMatches and SQL

Pure-function handlers for mm_find, mm_get, mm_recent, and _ping.
findMatches stays the source of truth — the handler is a thin wrapper
so the existing test suite still constrains ranking. mm_recent uses
file_records.modified_at until Phase 2 adds activity_events."
```

---

## Task 4: Daemon server (Unix socket + dispatch loop)

**Why:** This is the actual long-running process. Keep `server.ts` thin (entry point) and put the testable logic in `serverCore.ts` so we can construct a server in-process for the integration test without spawning a child.

**Files:**
- Create: `src/daemon/serverCore.ts`
- Create: `src/daemon/server.ts`
- Create: `tests/integration/daemonRoundtrip.test.ts`

**Step 1: Write the failing integration test**

```ts
// tests/integration/daemonRoundtrip.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import { openDatabase } from '../../src/index/db.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { encodeMessage, MessageDecoder, type DaemonResponse } from '../../src/daemon/protocol.js'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rpc(socketPath: string, method: string, params: unknown): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    const decoder = new MessageDecoder()
    client.setEncoding('utf8')
    client.on('data', chunk => {
      try {
        const messages = decoder.push(chunk as string) as DaemonResponse[]
        if (messages.length > 0) {
          client.end()
          resolve(messages[0]!)
        }
      } catch (err) { reject(err) }
    })
    client.on('error', reject)
    client.on('connect', () => {
      client.write(encodeMessage({ id: 'rpc-1', method, params }))
    })
  })
}

describe('daemon roundtrip', () => {
  let dir: string
  let server: DaemonServer
  let socketPath: string
  let dbPath: string

  beforeEach(async () => {
    dir = tmpDir('mm-daemon-')
    socketPath = path.join(dir, 'mmd.sock')
    dbPath = path.join(dir, 'test.sqlite')
    const db = openDatabase(dbPath)
    db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run('f1', '/tmp/thesis-intro.md', 'thesis-intro.md', 'md', 'text/markdown', '2026-04-18T10:00:00Z', '/tmp')
    db.close()
    server = await createServer({ socketPath, dbPath })
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('responds to _ping over the unix socket', async () => {
    const res = await rpc(socketPath, '_ping', {})
    expect(res.id).toBe('rpc-1')
    expect(res.result).toMatchObject({ ok: true, pid: process.pid })
  })

  it('serves mm_find with results matching direct findMatches', async () => {
    const res = await rpc(socketPath, 'mm_find', { query: 'thesis' })
    const results = res.result as Array<{ resultId: string }>
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.resultId).toBe('f1')
  })

  it('returns an error envelope for unknown methods', async () => {
    const res = await rpc(socketPath, 'mm_nonexistent', {})
    expect(res.error).toMatchObject({ code: -32601 })
  })

  it('removes a stale socket file on startup', async () => {
    await server.close()
    fs.writeFileSync(socketPath, '') // simulate leftover socket file
    server = await createServer({ socketPath, dbPath })
    const res = await rpc(socketPath, '_ping', {})
    expect(res.result).toMatchObject({ ok: true })
  })

  it('sets socket file mode to 0600', async () => {
    const stat = fs.statSync(socketPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/integration/daemonRoundtrip.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the server core**

```ts
// src/daemon/serverCore.ts
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../index/db.js'
import { createHandlers, type Handlers } from './handlers.js'
import { encodeMessage, MessageDecoder, type DaemonRequest, type DaemonResponse } from './protocol.js'

export type CreateServerOptions = {
  socketPath: string
  dbPath?: string
}

export type DaemonServer = {
  socketPath: string
  close: () => Promise<void>
}

export async function createServer(opts: CreateServerOptions): Promise<DaemonServer> {
  fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true })
  if (fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath)

  const db = openDatabase(opts.dbPath)
  const handlers = createHandlers({ db, startedAt: Date.now() })

  const server = net.createServer(socket => attachConnection(socket, handlers))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.socketPath, () => {
      server.off('error', reject)
      try {
        fs.chmodSync(opts.socketPath, 0o600)
      } catch (cause) {
        reject(cause)
        return
      }
      resolve()
    })
  })

  return {
    socketPath: opts.socketPath,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          db.close()
          if (fs.existsSync(opts.socketPath)) {
            try { fs.unlinkSync(opts.socketPath) } catch { /* ignore */ }
          }
          resolve()
        })
      }),
  }
}

function attachConnection(socket: net.Socket, handlers: Handlers): void {
  const decoder = new MessageDecoder()
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    let messages
    try {
      messages = decoder.push(chunk as string)
    } catch (cause) {
      socket.write(encodeMessage(errorResponse('parse-error', -32700, (cause as Error).message)))
      return
    }
    for (const message of messages) {
      const request = message as DaemonRequest
      socket.write(encodeMessage(dispatch(request, handlers)))
    }
  })

  socket.on('error', () => { /* ignore — client gone */ })
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

function errorResponse(id: string, code: number, message: string): DaemonResponse {
  return { id, error: { code, message } }
}
```

**Step 4: Add the bin entry point**

```ts
// src/daemon/server.ts
#!/usr/bin/env node
import { createServer } from './serverCore.js'
import { getDaemonSocketPath } from './paths.js'

async function main(): Promise<void> {
  const server = await createServer({ socketPath: getDaemonSocketPath() })
  console.error(`mmd listening on ${server.socketPath}`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`mmd received ${signal}, shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch(err => {
  console.error('mmd failed to start:', err)
  process.exit(1)
})
```

**Step 5: Run tests, confirm pass**

Run: `npx vitest run tests/integration/daemonRoundtrip.test.ts`
Expected: PASS, 5 tests.

**Step 6: Commit**

```bash
git add src/daemon/serverCore.ts src/daemon/server.ts tests/integration/daemonRoundtrip.test.ts
git commit -m "feat(daemon): add mmd unix-socket server and entry point

createServer() opens the SQLite index, listens on a unix socket with
0600 permissions, and dispatches NDJSON requests to the Handlers.
serverCore.ts is in-process testable; server.ts is the bin entry that
wires SIGTERM/SIGINT to clean shutdown.

First slice ships dispatch only — Slice 2 swaps the transport for MCP
proper, Slice 3 adds the watcher."
```

---

## Task 5: CLI-side daemon client

**Why:** A small client that the human CLI commands can call. `isDaemonRunning()` is the probe used by `mm find` to decide whether to delegate or fall through to direct DB.

**Files:**
- Create: `src/daemon/client.ts`
- Create: `tests/unit/daemon/client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/unit/daemon/client.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createServer, type DaemonServer } from '../../../src/daemon/serverCore.js'
import { call, isDaemonReachable } from '../../../src/daemon/client.js'

describe('daemon client', () => {
  let dir: string
  let server: DaemonServer | null
  let socketPath: string
  let dbPath: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-client-'))
    socketPath = path.join(dir, 'mmd.sock')
    dbPath = path.join(dir, 'test.sqlite')
    server = null
  })

  afterEach(async () => {
    if (server) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('isDaemonReachable returns false when no socket exists', async () => {
    expect(await isDaemonReachable(socketPath)).toBe(false)
  })

  it('isDaemonReachable returns true once daemon is up', async () => {
    server = await createServer({ socketPath, dbPath })
    expect(await isDaemonReachable(socketPath)).toBe(true)
  })

  it('call() returns the typed result from a method', async () => {
    server = await createServer({ socketPath, dbPath })
    const result = await call<{ ok: boolean }>(socketPath, '_ping', {})
    expect(result.ok).toBe(true)
  })

  it('call() rejects with the daemon error message', async () => {
    server = await createServer({ socketPath, dbPath })
    await expect(call(socketPath, 'mm_nope', {})).rejects.toThrow(/method not found/i)
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/daemon/client.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the client**

```ts
// src/daemon/client.ts
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { encodeMessage, MessageDecoder, type DaemonResponse } from './protocol.js'

export async function isDaemonReachable(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false
  return new Promise<boolean>(resolve => {
    const probe = net.createConnection(socketPath)
    const settle = (value: boolean): void => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(value)
    }
    probe.once('connect', () => settle(true))
    probe.once('error', () => settle(false))
    setTimeout(() => settle(false), 250)
  })
}

export function call<R = unknown>(socketPath: string, method: string, params: unknown): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const id = crypto.randomUUID()
    const client = net.createConnection(socketPath)
    const decoder = new MessageDecoder()
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      client.destroy()
      fn()
    }
    client.setEncoding('utf8')
    client.on('data', chunk => {
      try {
        const messages = decoder.push(chunk as string) as DaemonResponse<R>[]
        const match = messages.find(m => m.id === id)
        if (!match) return
        if (match.error) {
          settle(() => reject(new Error(match.error!.message)))
          return
        }
        settle(() => resolve(match.result as R))
      } catch (cause) {
        settle(() => reject(cause))
      }
    })
    client.on('error', err => settle(() => reject(err)))
    client.on('connect', () => {
      client.write(encodeMessage({ id, method, params }))
    })
  })
}
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run tests/unit/daemon/client.test.ts`
Expected: PASS, 4 tests.

**Step 5: Commit**

```bash
git add src/daemon/client.ts tests/unit/daemon/client.test.ts
git commit -m "feat(daemon): add unix-socket client used by mm CLI

isDaemonReachable() is the cheap probe mm find / mm show use to decide
whether to talk to the daemon or fall through to direct DB. call()
sends one request, awaits the response with the matching id, and
rejects with the daemon's error message on failure."
```

---

## Task 6: `mm daemon` subcommand (start / stop / status)

**Why:** A user-facing way to run the daemon outside systemd. Slice 4 ships systemd; before that, this is how you bring the daemon up interactively.

**Files:**
- Create: `src/cli/commands/daemon.ts`
- Create: `tests/unit/daemon/cliCommand.test.ts`
- Modify: `src/cli/main.ts` (register the subcommand)

**Step 1: Write the failing tests**

```ts
// tests/unit/daemon/cliCommand.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { runDaemonStatus, runDaemonStop } from '../../../src/cli/commands/daemon.js'

describe('mm daemon status', () => {
  let dir: string
  let logs: string[]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cmd-'))
    process.env.MM_DATA_DIR = dir
    logs = []
    vi.spyOn(console, 'log').mockImplementation(line => { logs.push(String(line)) })
    vi.spyOn(console, 'error').mockImplementation(line => { logs.push(String(line)) })
  })
  afterEach(() => {
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reports stopped when no pid file and no socket exist', async () => {
    await runDaemonStatus()
    expect(logs.join('\n')).toMatch(/stopped/i)
  })

  it('reports stale when pid file points at non-existent process', async () => {
    fs.writeFileSync(path.join(dir, 'mmd.pid'), '99999999')
    await runDaemonStatus()
    expect(logs.join('\n')).toMatch(/stale/i)
  })

  it('stop is a no-op when no pid file exists', async () => {
    await expect(runDaemonStop()).resolves.toBeUndefined()
    expect(logs.join('\n')).toMatch(/not running/i)
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/daemon/cliCommand.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the command**

```ts
// src/cli/commands/daemon.ts
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getDaemonPidPath, getDaemonSocketPath } from '../../daemon/paths.js'
import { isDaemonReachable, call } from '../../daemon/client.js'

export async function runDaemonStart(opts: { foreground?: boolean }): Promise<void> {
  const pidPath = getDaemonPidPath()
  if (fs.existsSync(pidPath)) {
    const existing = Number(fs.readFileSync(pidPath, 'utf8').trim())
    if (Number.isFinite(existing) && processAlive(existing)) {
      console.error(`mmd already running (pid ${existing})`)
      return
    }
    fs.unlinkSync(pidPath)
  }

  if (opts.foreground) {
    const { createServer } = await import('../../daemon/serverCore.js')
    const server = await createServer({ socketPath: getDaemonSocketPath() })
    fs.writeFileSync(pidPath, String(process.pid))
    console.error(`mmd listening on ${server.socketPath} (pid ${process.pid})`)
    const shutdown = async (sig: string): Promise<void> => {
      console.error(`mmd received ${sig}, shutting down`)
      await server.close()
      try { fs.unlinkSync(pidPath) } catch { /* ignore */ }
      process.exit(0)
    }
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
    return
  }

  // Background: spawn detached. Slice 4 hands this to systemd.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const serverScript = path.resolve(here, '..', '..', 'daemon', 'server.js')
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  fs.writeFileSync(pidPath, String(child.pid))
  console.log(`mmd started (pid ${child.pid})`)
}

export async function runDaemonStop(): Promise<void> {
  const pidPath = getDaemonPidPath()
  if (!fs.existsSync(pidPath)) {
    console.error('mmd not running (no pid file)')
    return
  }
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim())
  if (!Number.isFinite(pid) || !processAlive(pid)) {
    fs.unlinkSync(pidPath)
    console.error('mmd not running (stale pid file removed)')
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50; i += 1) {
    if (!processAlive(pid)) break
    await sleep(100)
  }
  if (processAlive(pid)) {
    process.kill(pid, 'SIGKILL')
    console.error(`mmd force-killed (pid ${pid})`)
  } else {
    console.log(`mmd stopped (pid ${pid})`)
  }
  if (fs.existsSync(pidPath)) {
    try { fs.unlinkSync(pidPath) } catch { /* ignore */ }
  }
}

export async function runDaemonStatus(): Promise<void> {
  const pidPath = getDaemonPidPath()
  const socketPath = getDaemonSocketPath()
  if (!fs.existsSync(pidPath)) {
    console.log(`mmd: stopped (socket: ${socketPath})`)
    return
  }
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim())
  if (!Number.isFinite(pid) || !processAlive(pid)) {
    console.log(`mmd: stale pid file (pid ${pid}); run \`mm daemon start\``)
    return
  }
  const reachable = await isDaemonReachable(socketPath)
  if (!reachable) {
    console.log(`mmd: pid ${pid} alive but socket not reachable; check ${socketPath}`)
    return
  }
  const ping = await call<{ uptime_ms: number; version: string }>(socketPath, '_ping', {})
  console.log(`mmd: running (pid ${pid}, uptime ${Math.round(ping.uptime_ms / 1000)}s, version ${ping.version})`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

**Step 4: Wire into `src/cli/main.ts`**

Add the import and subcommand registration:

```ts
// near the other imports
import { runDaemonStart, runDaemonStatus, runDaemonStop } from './commands/daemon.js'

// after the existing program.command(...) calls
const daemon = program.command('daemon').description('Control the mmd background daemon')
daemon
  .command('start')
  .description('Start mmd (use --foreground for systemd)')
  .option('--foreground', 'run in the foreground (do not detach)')
  .action(runDaemonStart)
daemon.command('stop').description('Stop a running mmd').action(runDaemonStop)
daemon.command('status').description('Report mmd status').action(runDaemonStatus)
```

**Step 5: Run tests, confirm pass**

Run: `npx vitest run tests/unit/daemon/cliCommand.test.ts`
Expected: PASS, 3 tests.

Then verify the wiring doesn't break the existing CLI tests:

Run: `npx vitest run`
Expected: PASS, full suite green.

**Step 6: Commit**

```bash
git add src/cli/commands/daemon.ts src/cli/main.ts tests/unit/daemon/cliCommand.test.ts
git commit -m "feat(cli): add mm daemon start/stop/status subcommand

Lifecycle controls for mmd outside systemd. start spawns detached by
default; --foreground keeps it in the current shell so Slice 4's
systemd unit can use Type=simple. stop sends SIGTERM, waits 5s, then
SIGKILL. status reads the pid file, verifies the process is alive,
and pings the socket to confirm the daemon is responsive."
```

---

## Task 7: `mm find` delegates to daemon when reachable

**Why:** This is the user-visible payoff of the slice. `mm find` should be transparently faster (no DB cold-open) when the daemon is up, and fall back to direct DB access when it isn't.

**Files:**
- Modify: `src/cli/commands/find.ts`
- Modify: `tests/unit/cliCommands.test.ts` (add a regression test for the fallback path)

**Step 1: Write the failing test**

Open `tests/unit/cliCommands.test.ts` and add:

```ts
import { runFind } from '../../src/cli/commands/find.js'
// ...existing imports...

describe('mm find delegation', () => {
  // existing tests...

  it('falls through to direct DB when no daemon is reachable', async () => {
    process.env.MM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-find-fallback-'))
    // Seed an empty DB so the direct path runs without errors.
    const { openDatabase } = await import('../../src/index/db.js')
    openDatabase().close()

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation(line => { logs.push(String(line)) })
    await runFind('anything')
    expect(logs.join('\n')).toMatch(/no results/i)

    delete process.env.MM_DATA_DIR
    vi.restoreAllMocks()
  })
})
```

(If `cliCommands.test.ts` does not yet import `vi`, `fs`, `os`, `path`, add those imports.)

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/cliCommands.test.ts`
Expected: FAIL — `runFind` is currently sync and does not check the daemon.

**Step 3: Update `runFind` to be async + try the daemon first**

```ts
// src/cli/commands/find.ts
import { openDatabase } from '../../index/db.js'
import { formatSearchResults } from '../../output/formatResult.js'
import { findMatches } from '../../search/find.js'
import { call, isDaemonReachable } from '../../daemon/client.js'
import { getDaemonSocketPath } from '../../daemon/paths.js'
import type { SearchResult } from '../../types.js'

export async function runFind(query: string): Promise<void> {
  const socketPath = getDaemonSocketPath()
  if (await isDaemonReachable(socketPath)) {
    const results = await call<SearchResult[]>(socketPath, 'mm_find', { query })
    console.log(formatSearchResults(results))
    return
  }
  const db = openDatabase()
  const results = findMatches(db, query)
  db.close()
  console.log(formatSearchResults(results))
}
```

Note: commander accepts an async action; no change needed in `main.ts`.

**Step 4: Run test, confirm pass**

Run: `npx vitest run tests/unit/cliCommands.test.ts`
Expected: PASS, full file green.

**Step 5: Commit**

```bash
git add src/cli/commands/find.ts tests/unit/cliCommands.test.ts
git commit -m "feat(cli): delegate mm find to daemon when reachable

When mmd is up, mm find sends mm_find over the unix socket; otherwise
it falls through to opening the DB directly. The fallback path means
mm find keeps working on a fresh install before the daemon is started
or on systems where the daemon is intentionally off."
```

---

## Task 8: `mm show` delegates to daemon when reachable

**Why:** Same pattern as Task 7, applied to the `show` command. This is also where the `mm_get` handler proves itself end-to-end.

**Files:**
- Modify: `src/cli/commands/show.ts`
- Modify: `tests/unit/cliCommands.test.ts` (or add a sibling file)

**Step 1: Write the failing test**

Add to the existing test file (or create `tests/unit/showCommand.test.ts`):

```ts
it('mm show falls through to direct DB when daemon absent', async () => {
  process.env.MM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-show-fallback-'))
  const { openDatabase } = await import('../../src/index/db.js')
  const db = openDatabase()
  db.prepare(
    `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run('show1', '/tmp/a.md', 'a.md', 'md', 'text/markdown', '2026-04-18T10:00:00Z', '/tmp')
  db.close()

  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation(line => { logs.push(String(line)) })
  await runShow('show1')
  expect(logs.join('\n')).toMatch(/a\.md/)

  delete process.env.MM_DATA_DIR
  vi.restoreAllMocks()
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/unit/cliCommands.test.ts`
Expected: FAIL — `runShow` is sync and does not understand the daemon path.

**Step 3: Update `runShow`**

Refactor `src/cli/commands/show.ts` so the formatting logic is a pure function over the same shape `mm_get` returns, and the entry point picks daemon-vs-direct:

```ts
// src/cli/commands/show.ts
import { openDatabase } from '../../index/db.js'
import { call, isDaemonReachable } from '../../daemon/client.js'
import { getDaemonSocketPath } from '../../daemon/paths.js'
import type { GetResult } from '../../daemon/handlers.js'

// keep the existing FileRow / RepoRow types and parseMetadata / normalizeSnippet helpers

export async function runShow(id: string): Promise<void> {
  const result = (await isDaemonReachable(getDaemonSocketPath()))
    ? await call<GetResult>(getDaemonSocketPath(), 'mm_get', { id })
    : loadDirect(id)

  if (!result) {
    console.error(`No result found for id: ${id}`)
    process.exitCode = 1
    return
  }
  printRecord(result)
}

function loadDirect(id: string): GetResult {
  const db = openDatabase()
  try {
    // reuse existing query logic — copy the FileRow / RepoRow / textBlobs queries here
    // and return them in the GetResult shape produced by handlers.loadRecord.
  } finally {
    db.close()
  }
  return null // unreachable — placeholder to satisfy TS until the body is filled in
}

function printRecord(result: NonNullable<GetResult>): void {
  // move the existing formatting code into here, switching on result.kind
}
```

Implementer's note: the cleanest refactor is to move the SQL out of `runShow` into a `loadRecord(db, id): GetResult` helper that both the daemon handler and the CLI fallback can call. If you do this, you can probably delete the duplicated queries from `handlers.ts` and `show.ts` and import the same helper in both.

**Step 4: Run tests, confirm pass**

Run: `npx vitest run`
Expected: PASS, full suite green.

**Step 5: Commit**

```bash
git add src/cli/commands/show.ts src/daemon/handlers.ts tests/unit/cliCommands.test.ts
git commit -m "feat(cli): delegate mm show to daemon when reachable

Same pattern as mm find: mm show calls mm_get over the socket when
mmd is up, otherwise opens the DB directly. The record-loading SQL is
factored into a single helper used by both the handler and the CLI
fallback so the two paths cannot drift."
```

---

## Task 9: `mmd` bin entry in package.json + build verification

**Why:** Without a bin entry, the daemon can be run via `tsx src/daemon/server.ts` but not as a published binary. Slice 4's installer will need this.

**Files:**
- Modify: `package.json`

**Step 1: Add the bin entry**

```jsonc
{
  "bin": {
    "mm":  "./dist/cli/main.js",
    "mmd": "./dist/daemon/server.js"
  },
  "scripts": {
    "daemon": "tsx src/daemon/server.ts"
  }
}
```

**Step 2: Verify build produces the expected file**

Run: `npm run build`
Expected: exits 0; `dist/daemon/server.js` exists; `dist/daemon/serverCore.js` exists.

Run: `node dist/daemon/server.js &` (then `kill %1` after a second)
Expected: prints `mmd listening on …`; exits cleanly on SIGTERM.

**Step 3: Commit**

```bash
git add package.json
git commit -m "build: register mmd as a published bin and add npm run daemon

dist/daemon/server.js becomes the binary that systemd (Slice 4) and
mm daemon start (background mode) launch. The npm run daemon script
makes foreground iteration trivial during development."
```

---

## Task 10: Ship-bar verification against the real index

**Why:** Doc 23 §10 and D-016 both demand real-machine-grounded validation, not just unit tests. This is the slice acceptance check.

**Files:**
- Create: `docs/24-phase-1-slice-1-validation.md`

**Step 1: Run the verification protocol**

```bash
# 1. Confirm the existing index has content
mm find "thesis" | tee /tmp/mm-find-direct.txt

# 2. Bring the daemon up in the foreground in one terminal
npm run daemon
# (in another terminal)

# 3. Confirm the daemon is reachable
mm daemon status     # expect: "mmd: running (pid …)"

# 4. Same query, now via the daemon
mm find "thesis" | tee /tmp/mm-find-daemon.txt

# 5. Compare
diff /tmp/mm-find-direct.txt /tmp/mm-find-daemon.txt
# Expected: no diff

# 6. show parity
mm show <pick-an-id> | tee /tmp/mm-show-direct.txt
# kill daemon, rerun, diff — confirm parity for show too

# 7. Clean shutdown
kill -TERM $(cat ~/.local/share/machine-memory/mmd.pid)
mm daemon status     # expect: "mmd: stopped"
```

**Step 2: Write up the validation result**

Create `docs/24-phase-1-slice-1-validation.md` recording:
- Date and host
- Index size at validation time (file count, repo count, blob count — query the DB directly)
- The 3 proof queries chosen (one keyword, one fuzzy, one source-hint)
- Direct-vs-daemon diff result for each
- `mm show` parity result for one record
- Clean-shutdown observation

If anything diverges, do not commit Slice 1 done. Open a follow-up entry under D-016.

**Step 3: Commit**

```bash
git add docs/24-phase-1-slice-1-validation.md
git commit -m "docs: validate Slice 1 daemon parity against real index

Records the diff-clean comparison of mm find direct vs via daemon on
three proof queries plus an mm show parity check, with index size
captured at the time of run. Slice 1 ship bar is met."
```

---

## End-of-slice checklist

Before claiming Slice 1 complete:

- [ ] All tests green: `npx vitest run`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Build succeeds: `npm run build`
- [ ] `mm daemon start && mm daemon status` reports running with a pid
- [ ] `mm find "x"` results match between daemon-up and daemon-down (recorded in doc 24)
- [ ] `mm daemon stop` cleanly shuts down and removes pid file
- [ ] `docs/24-phase-1-slice-1-validation.md` committed
- [ ] No new runtime dependencies added (`package.json` diff is bin entry only)
- [ ] Decision log entries D-020, D-021, D-022 still load-bearing for next slice

If any item is incomplete, label the slice "implemented but unverified" per CLAUDE.md and stop here for review.

## Open questions to resolve in Slice 2 (do not address now)

- Replace NDJSON transport with the MCP `2025-06-18` protocol via `@modelcontextprotocol/sdk` — the handler layer should not need to change.
- Add `mm_recent` activity-event source once Phase 2 lands; Slice 2 can keep using `modified_at` as the dummy data source.
- `mm_subscribe` streaming — design now, build in Slice 3 alongside the watcher.
