import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from '../../../src/cli/commands/daemon.js'
import { isDaemonReachable } from '../../../src/daemon/client.js'
import { getDaemonSocketPath } from '../../../src/daemon/paths.js'

describe('mm daemon status', () => {
  let dir: string
  let logs: string[]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cmd-'))
    process.env.MM_DATA_DIR = dir
    process.exitCode = 0
    logs = []
    vi.spyOn(console, 'log').mockImplementation(line => {
      logs.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(line => {
      logs.push(String(line))
    })
  })
  afterEach(() => {
    delete process.env.MM_DATA_DIR
    process.exitCode = 0
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      /* ignore */
    }
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

  it('detached start errors when serverScript is missing', async () => {
    // Under tsx, import.meta.url points at src/cli/commands/daemon.ts, so the
    // resolved server.js path under src/daemon/ does not exist.
    await runDaemonStart({})
    expect(process.exitCode).toBe(1)
    expect(logs.join('\n')).toMatch(/cannot find server script/i)
    expect(fs.existsSync(path.join(dir, 'mmd.pid'))).toBe(false)
  })

  it('foreground start cleans up on pid-write failure', async () => {
    // Stub writeFileSync to throw only for the pid path; the server listens
    // first, then the pid-write failure must trigger server.close() cleanup.
    const pidPath = path.join(dir, 'mmd.pid')
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, opts) => {
      if (typeof target === 'string' && target === pidPath) {
        throw new Error('simulated EACCES on pid file')
      }
      return realWrite(target, data as string, opts)
    })
    await runDaemonStart({ foreground: true })
    expect(logs.join('\n')).toMatch(/failed to write pid file/i)
    expect(process.exitCode).toBe(1)
    const reachable = await isDaemonReachable(getDaemonSocketPath())
    expect(reachable).toBe(false)
  })
})
