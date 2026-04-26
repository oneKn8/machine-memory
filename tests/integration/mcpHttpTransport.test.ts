import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { openDatabase } from '../../src/index/db.js'
import { getMcpUrlPath } from '../../src/daemon/paths.js'

describe('mmd HTTP MCP transport', () => {
  let dir: string
  let daemon: DaemonServer | null
  let client: Client | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-http-'))
    process.env.MM_DATA_DIR = dir
    const dbPath = path.join(dir, 'machine-memory.sqlite')
    const db = openDatabase(dbPath)
    db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run('f1', '/tmp/thesis-intro.md', 'thesis-intro.md', 'md', 'text/markdown', '2026-04-18T10:00:00Z', '/tmp')
    db.close()
    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath,
    })
    client = null
  })

  afterEach(async () => {
    if (client) await client.close()
    if (daemon) await daemon.close()
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the discovery file with a 127.0.0.1 url on startup', () => {
    const urlPath = getMcpUrlPath()
    expect(fs.existsSync(urlPath)).toBe(true)
    const url = fs.readFileSync(urlPath, 'utf8').trim()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it('removes the discovery file on shutdown', async () => {
    const urlPath = getMcpUrlPath()
    expect(fs.existsSync(urlPath)).toBe(true)
    await daemon!.close()
    daemon = null
    expect(fs.existsSync(urlPath)).toBe(false)
  })

  it('serves mm_find over HTTP via the SDK client', async () => {
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    client = new Client({ name: 'http-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual(['mm_find', 'mm_get', 'mm_recent'])
    const res = await client.callTool({ name: 'mm_find', arguments: { query: 'thesis' } })
    expect(res.structuredContent).toMatchObject({
      query: 'thesis',
      results: [expect.objectContaining({ id: 'f1' })],
    })
  })

  it('closes the bound http listener if writing the discovery file fails', async () => {
    // Tear down the running server first (beforeEach already started one).
    await daemon!.close()
    daemon = null

    const urlPath = getMcpUrlPath()

    // Force the next writeFileSync targeting urlPath to throw, simulating
    // a disk/permission failure between bind and discovery-file write.
    const realWrite = fs.writeFileSync.bind(fs)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      p: Parameters<typeof fs.writeFileSync>[0],
      data: Parameters<typeof fs.writeFileSync>[1],
      options?: Parameters<typeof fs.writeFileSync>[2],
    ): void => {
      if (typeof p === 'string' && p === urlPath) {
        throw new Error('simulated EACCES on mcp.url write')
      }
      return realWrite(p, data, options)
    }) as typeof fs.writeFileSync)

    // Spy on http.Server#close to prove the orphaned listener gets closed.
    const closeSpy = vi.spyOn(http.Server.prototype, 'close')

    await expect(createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath: path.join(dir, 'machine-memory.sqlite'),
    })).rejects.toThrow(/simulated EACCES|mcp http failed/i)

    // The HTTP listener must have been closed during the failed startup.
    expect(closeSpy).toHaveBeenCalled()

    // No leftover discovery file or unix socket.
    expect(fs.existsSync(urlPath)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'mmd.sock'))).toBe(false)

    writeSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it('binds to 127.0.0.1 only', async () => {
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    const port = new URL(url).port
    const { default: net } = await import('node:net')
    // Loopback connect should succeed
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
        socket.end()
        resolve()
      })
      socket.on('error', reject)
    })
  })

  it('shuts down within 500ms even with an idle TCP client holding the port open', async () => {
    // close() on a plain http.Server waits for accepted sockets to finish on
    // their own. A keepalive client (or a stuck POST) blocks forever. The
    // daemon must force-close all connections so SIGTERM-driven shutdown does
    // not turn into SIGKILL with stale mcp.url + socket files left behind.
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    const port = Number(new URL(url).port)
    const { default: net } = await import('node:net')
    const idle = await new Promise<InstanceType<typeof net.Socket>>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket))
      socket.once('error', reject)
    })
    try {
      const start = Date.now()
      await Promise.race([
        daemon!.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('daemon.close() did not return within 500 ms')), 500),
        ),
      ])
      expect(Date.now() - start).toBeLessThan(500)
      daemon = null
    } finally {
      idle.destroy()
    }
  })

  it('creates the discovery file parent directory if it does not exist', async () => {
    // Simulates a freshly-cloned machine where ~/.local/share/machine-memory
    // has never been created. createServer must not throw ENOENT trying to
    // write mcp.url; startMcpHttp owns mkdir-ing the parent.
    await daemon!.close()
    daemon = null

    const freshDataDir = path.join(dir, 'never-existed-before')
    expect(fs.existsSync(freshDataDir)).toBe(false)
    process.env.MM_DATA_DIR = freshDataDir

    daemon = await createServer({
      socketPath: path.join(freshDataDir, 'mmd.sock'),
      pidPath: path.join(freshDataDir, 'mmd.pid'),
      dbPath: path.join(freshDataDir, 'machine-memory.sqlite'),
    })

    expect(fs.existsSync(path.join(freshDataDir, 'mcp.url'))).toBe(true)
  })

  it('survives an early client disconnect mid-request without unhandled rejections', async () => {
    // Deterministic proof of the race is hard — per-request transport and
    // server instances live inside the http handler closure. This test fires
    // several aborted POSTs to exercise the early-close codepath. If the
    // cleanup listener were still in the `finally` block, an unhandled
    // rejection from the un-closed transport would surface on the process.
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      for (let i = 0; i < 5; i++) {
        const ac = new AbortController()
        const reqPromise = fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }),
          signal: ac.signal,
        }).catch(() => undefined)
        // Abort immediately so the request ends before handleRequest settles.
        ac.abort()
        await reqPromise
      }
      // Give any late rejections a tick to land.
      await new Promise(r => setTimeout(r, 50))
      expect(unhandled).toEqual([])

      // And the daemon is still healthy for new requests.
      client = new Client({ name: 'early-disconnect', version: '0.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(url))
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(t => t.name).sort()).toEqual(['mm_find', 'mm_get', 'mm_recent'])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
