import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createServer, type DaemonServer } from '../../../src/daemon/serverCore.js'
import { call, DaemonCallError, isDaemonReachable } from '../../../src/daemon/client.js'

describe('daemon client', () => {
  let dir: string
  let server: DaemonServer | null
  let rawServer: net.Server | null
  let socketPath: string
  let dbPath: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-client-'))
    // Pin MM_DATA_DIR to the per-test tmp dir so createServer's MCP discovery
    // file (`mcp.url`) lands inside the sandbox instead of clobbering the real
    // ~/.local/share/machine-memory of whoever runs the suite.
    process.env.MM_DATA_DIR = dir
    socketPath = path.join(dir, 'mmd.sock')
    dbPath = path.join(dir, 'test.sqlite')
    server = null
    rawServer = null
  })

  afterEach(async () => {
    if (server) await server.close()
    if (rawServer) await new Promise<void>(resolve => rawServer!.close(() => resolve()))
    delete process.env.MM_DATA_DIR
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

  it('call() times out when the daemon never responds', async () => {
    const sockets: net.Socket[] = []
    rawServer = net.createServer(socket => {
      // accept the connection but never write a response
      sockets.push(socket)
    })
    await new Promise<void>(resolve => rawServer!.listen(socketPath, () => resolve()))
    try {
      const start = Date.now()
      await expect(call(socketPath, '_ping', {}, { timeoutMs: 100 })).rejects.toThrow(/timed out/i)
      expect(Date.now() - start).toBeLessThan(500)
    } finally {
      for (const s of sockets) s.destroy()
    }
  })

  it('call() preserves the daemon error code on reject', async () => {
    server = await createServer({ socketPath, dbPath })
    const err = await call(socketPath, 'mm_nope', {}).catch(e => e as Error)
    expect(err).toBeInstanceOf(DaemonCallError)
    expect((err as DaemonCallError).code).toBe(-32601)
  })
})
