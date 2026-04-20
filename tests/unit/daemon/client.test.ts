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
