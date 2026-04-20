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
      try {
        fs.unlinkSync(pidPath)
      } catch {
        /* ignore */
      }
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
    try {
      fs.unlinkSync(pidPath)
    } catch {
      /* ignore */
    }
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
  console.log(
    `mmd: running (pid ${pid}, uptime ${Math.round(ping.uptime_ms / 1000)}s, version ${ping.version})`,
  )
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
