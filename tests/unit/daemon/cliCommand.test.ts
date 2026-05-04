import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from '../../../src/cli/commands/daemon.js'
import { isDaemonReachable } from '../../../src/daemon/client.js'
import { getDaemonSocketPath } from '../../../src/daemon/paths.js'
import { createServer, type DaemonServer } from '../../../src/daemon/serverCore.js'

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
    // resolved server.js path under src/daemon/ does not exist — UNLESS a
    // prior crashed run of the sibling "socket already taken" test left its
    // stub at src/daemon/server.js on disk (the stub is created in a
    // try/finally; a vitest crash before finally strands it). Pre-clean
    // here so this test asserts what it claims regardless of prior state.
    const stubPath = path.resolve(process.cwd(), 'src/daemon/server.js')
    if (fs.existsSync(stubPath)) fs.unlinkSync(stubPath)

    await runDaemonStart({})
    expect(process.exitCode).toBe(1)
    expect(logs.join('\n')).toMatch(/cannot find server script/i)
    expect(fs.existsSync(path.join(dir, 'mmd.pid'))).toBe(false)
  })

  it('status reports unresponsive when ping returns garbage', async () => {
    // Stand up a "broken" daemon that accepts connections but writes garbage,
    // forcing call(_ping) to reject. Without a guard, the rejection surfaces
    // as an unhandled "failed to parse daemon message" stack trace.
    const socketPath = getDaemonSocketPath()
    const server = net.createServer(socket => {
      socket.on('data', () => {
        socket.write('not-valid-json\n')
      })
      socket.on('error', () => {
        /* ignore — peer may close once call() rejects */
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => resolve())
    })
    fs.writeFileSync(path.join(dir, 'mmd.pid'), String(process.pid))

    try {
      await expect(runDaemonStatus()).resolves.toBeUndefined()
      expect(logs.join('\n')).toMatch(/unresponsive/i)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      try {
        fs.unlinkSync(socketPath)
      } catch {
        /* already removed by server.close */
      }
    }
  })

  it('status reports running with unknown pid when daemon is up without pid file', async () => {
    // Start a real serverCore daemon WITHOUT a pid path — simulates `mmd` or
    // `npm run daemon`. Status must not lie that the daemon is stopped.
    const socketPath = getDaemonSocketPath()
    let server: DaemonServer
    try {
      server = await createServer({ socketPath })
    } catch (err) {
      throw err
    }
    try {
      await runDaemonStatus()
      const out = logs.join('\n')
      expect(out).toMatch(/pid unknown/i)
      expect(out).toMatch(/started outside/i)
    } finally {
      await server.close()
    }
  })

  it('stop refuses with hint when pid is unknown but socket is reachable', async () => {
    const socketPath = getDaemonSocketPath()
    const server = await createServer({ socketPath })
    try {
      await runDaemonStop()
      const out = logs.join('\n')
      expect(out).toMatch(/pid is unknown/i)
      expect(process.exitCode).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('detached start surfaces child error when socket is already taken', async () => {
    // Under tsx, runDaemonStart resolves serverScript at src/daemon/server.js
    // (not dist/). Drop a one-line ESM stub there that delegates to the built
    // dist server so the spawned child runs the real createServer logic.
    const distServer = path.resolve(process.cwd(), 'dist/daemon/server.js')
    if (!fs.existsSync(distServer)) {
      console.warn(`skipping: ${distServer} not built — run npm run build first`)
      return
    }
    const stubPath = path.resolve(process.cwd(), 'src/daemon/server.js')
    const stubExisted = fs.existsSync(stubPath)
    if (!stubExisted) {
      fs.writeFileSync(stubPath, "import '../../dist/daemon/server.js'\n")
    }

    // Stand up a real serverCore daemon on the tmp socket so the spawned
    // child hits createServer's live-socket refusal and exits early. The
    // parent must surface that reason, not a 2s timeout.
    const socketPath = getDaemonSocketPath()
    const server = await createServer({ socketPath })
    try {
      await runDaemonStart({})
      const out = logs.join('\n')
      expect(out).toMatch(/failed to start/i)
      expect(out).toMatch(/already listening/i)
      expect(process.exitCode).toBe(1)
    } finally {
      await server.close()
      if (!stubExisted) {
        try {
          fs.unlinkSync(stubPath)
        } catch {
          /* ignore */
        }
      }
    }
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
