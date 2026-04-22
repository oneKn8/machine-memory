import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import { openDatabase } from '../../src/index/db.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { isDaemonReachable } from '../../src/daemon/client.js'
import { encodeMessage, MessageDecoder, type DaemonResponse } from '../../src/daemon/protocol.js'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function connectAndReadFirst(
  socketPath: string,
  write: (client: net.Socket) => void,
): Promise<DaemonResponse> {
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
      } catch (err) {
        reject(err)
      }
    })
    client.on('error', reject)
    client.on('connect', () => write(client))
  })
}

function rpc(socketPath: string, method: string, params: unknown): Promise<DaemonResponse> {
  return connectAndReadFirst(socketPath, client => {
    client.write(encodeMessage({ id: 'rpc-1', method, params }))
  })
}

function rpcRaw(socketPath: string, line: string): Promise<DaemonResponse> {
  return connectAndReadFirst(socketPath, client => {
    client.write(line)
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

  it('mm_get returns null result envelope for unknown id', async () => {
    const res = await rpc(socketPath, 'mm_get', { id: 'definitely-not-a-real-id' })
    expect(res.error).toBeUndefined()
    expect(res.result).toBeNull()
  })

  it('rejects requests whose id is not a string', async () => {
    const malformed = JSON.stringify({ id: 123, method: '_ping', params: {} }) + '\n'
    const res = await rpcRaw(socketPath, malformed)
    expect(res.error).toMatchObject({ code: -32600 })
    expect(res.id).toBeNull()
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

  it('returns id: null on parse error (JSON-RPC 2.0 compliance)', async () => {
    const res = await new Promise<DaemonResponse>((resolve, reject) => {
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
        } catch (err) {
          reject(err)
        }
      })
      client.on('error', reject)
      client.on('connect', () => {
        client.write('this is not json\n')
      })
    })
    expect(res.id).toBeNull()
    expect(res.error).toMatchObject({ code: -32700 })
  })

  it('writes a pid file when pidPath is provided', async () => {
    await server.close()
    const pidPath = path.join(dir, 'mmd.pid')
    server = await createServer({ socketPath, dbPath, pidPath })
    expect(fs.existsSync(pidPath)).toBe(true)
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(String(process.pid))
    await server.close()
    expect(fs.existsSync(pidPath)).toBe(false)
    // Re-open server so afterEach's close() is a no-op-friendly call
    server = await createServer({ socketPath, dbPath })
  })

  it('refuses to start when another daemon is already listening', async () => {
    // First server already up via beforeEach. A second createServer on the
    // same socket must refuse rather than steal the socket from the live one.
    await expect(createServer({ socketPath, dbPath })).rejects.toThrow(
      /another daemon is already listening/i,
    )
    // First server still owns the socket and is reachable.
    const res = await rpc(socketPath, '_ping', {})
    expect(res.result).toMatchObject({ ok: true })
  })

  it('refuses to start when pid file points at a live process', async () => {
    await server.close()
    const pidPath = path.join(dir, 'mmd.pid')
    fs.writeFileSync(pidPath, String(process.pid))
    await expect(createServer({ socketPath, dbPath, pidPath })).rejects.toThrow(
      /another mmd is running/i,
    )
    // Pid file should still be present (we did not own it; do not unlink).
    expect(fs.existsSync(pidPath)).toBe(true)
    fs.unlinkSync(pidPath)
    // Re-open server so afterEach's close() is a no-op-friendly call
    server = await createServer({ socketPath, dbPath })
  })

  it('removes a stale pid file pointing at a dead process', async () => {
    await server.close()
    const pidPath = path.join(dir, 'mmd.pid')
    fs.writeFileSync(pidPath, '99999999')
    server = await createServer({ socketPath, dbPath, pidPath })
    expect(fs.existsSync(pidPath)).toBe(true)
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(String(process.pid))
  })

  it('tears down server, db, and socket when chmod fails after listen', async () => {
    // Free the existing server from beforeEach so the chmod-failing call
    // can take a clean shot at this socket path.
    await server.close()
    const pidPath = path.join(dir, 'mmd.pid')

    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementationOnce(() => {
      throw new Error('simulated EACCES on chmod')
    })

    try {
      await expect(
        createServer({ socketPath, dbPath, pidPath }),
      ).rejects.toThrow(/simulated EACCES/)

      // Socket file must be cleaned up so the next bind is unobstructed.
      expect(fs.existsSync(socketPath)).toBe(false)
      // Pid file must not be left behind either.
      expect(fs.existsSync(pidPath)).toBe(false)
      // And no zombie listener should be reachable on that path.
      expect(await isDaemonReachable(socketPath)).toBe(false)
    } finally {
      chmodSpy.mockRestore()
    }

    // A fresh start on the same socket must succeed — proving the previous
    // failed attempt left no half-bound listener and no live-socket guard trip.
    server = await createServer({ socketPath, dbPath })
    const res = await rpc(socketPath, '_ping', {})
    expect(res.result).toMatchObject({ ok: true })
  })

  it('closes promptly even when a client connection is still open', async () => {
    const client = net.createConnection(socketPath)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve())
      client.once('error', reject)
    })

    const start = Date.now()
    await Promise.race([
      server.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('server.close() did not return within 500 ms')), 500),
      ),
    ])
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)

    // Re-open server so afterEach's close() is a no-op-friendly call
    server = await createServer({ socketPath, dbPath })
    client.destroy()
  })
})
