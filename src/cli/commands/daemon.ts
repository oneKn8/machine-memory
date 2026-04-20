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
      // Already-running is a successful no-op (matches `systemctl start`).
      // Slice 4's installer relies on this to be idempotent.
      console.error(`mmd already running (pid ${existing})`)
      return
    }
    fs.unlinkSync(pidPath)
  }

  if (opts.foreground) {
    const { createServer } = await import('../../daemon/serverCore.js')
    let server
    try {
      server = await createServer({
        socketPath: getDaemonSocketPath(),
        pidPath,
      })
    } catch (cause) {
      console.error(`mmd: failed to start: ${(cause as Error).message}`)
      process.exitCode = 1
      return
    }
    console.error(`mmd listening on ${server.socketPath} (pid ${process.pid})`)
    const shutdown = async (sig: string): Promise<void> => {
      console.error(`mmd received ${sig}, shutting down`)
      await server.close()
      process.exit(0)
    }
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
    return
  }

  // Background: spawn detached. Slice 4 hands this to systemd.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const serverScript = path.resolve(here, '..', '..', 'daemon', 'server.js')
  if (!fs.existsSync(serverScript)) {
    console.error(`mmd: cannot find server script at ${serverScript}.`)
    console.error('Run `npm run build` first, or use `mm daemon start --foreground`.')
    process.exitCode = 1
    return
  }
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  })
  if (!child.pid) {
    console.error('mmd failed to start: spawn returned no pid')
    process.exitCode = 1
    return
  }
  // Capture child stderr so an early createServer failure (e.g. the
  // live-socket guard refusing to steal an existing socket) can surface
  // a real reason instead of a misleading 2s timeout.
  let stderrBuf = ''
  const stderrLimit = 2048
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderrBuf.length >= stderrLimit) return
    stderrBuf += chunk
    if (stderrBuf.length > stderrLimit) stderrBuf = stderrBuf.slice(0, stderrLimit)
  })
  child.unref()

  // Race the pid-file poll against an early child exit. If the child dies
  // before the pid file appears, surface its captured stderr.
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null }
  const exitState: { value: ExitInfo | null } = { value: null }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitState.value = { code, signal }
  }
  child.once('exit', onExit)

  // The child runs `dist/daemon/server.js`, which writes the pid file via
  // createServer({pidPath}). Wait briefly for that to land so the next
  // `mm daemon status` finds the pid we report here.
  const deadline = Date.now() + 2000
  let pidFromFile: number | null = null
  while (Date.now() < deadline) {
    if (exitState.value) break
    if (fs.existsSync(pidPath)) {
      const raw = fs.readFileSync(pidPath, 'utf8').trim()
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed > 0) {
        pidFromFile = parsed
        break
      }
    }
    await sleep(50)
  }
  child.off('exit', onExit)

  if (pidFromFile !== null) {
    console.log(`mmd started (pid ${pidFromFile})`)
    return
  }
  const exit = exitState.value
  if (exit) {
    // Give the stderr 'data' handler a tick to drain anything buffered.
    await sleep(20)
    const reason = lastErrorLine(stderrBuf)
    const codeStr = exit.code !== null ? `exit code ${exit.code}` : `signal ${exit.signal}`
    const suffix = reason ? `: ${reason}` : '; check stderr logs'
    console.error(`mmd failed to start (${codeStr})${suffix}`)
    process.exitCode = 1
    return
  }
  console.log(
    `mmd started (child pid ${child.pid}); pid file did not appear within 2s — check logs`,
  )
}

function lastErrorLine(stderr: string): string | null {
  if (!stderr) return null
  const lines = stderr
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
  if (lines.length === 0) return null
  // Prefer the last line that looks like an error (contains "error",
  // "failed", "already", or a colon). Fall back to the last non-empty line.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/error|failed|already|: /i.test(lines[i])) return lines[i]
  }
  return lines[lines.length - 1]
}

export async function runDaemonStop(): Promise<void> {
  const pidPath = getDaemonPidPath()
  const socketPath = getDaemonSocketPath()
  if (!fs.existsSync(pidPath)) {
    // No pid file does NOT mean no daemon — `mmd` and `npm run daemon` from
    // before the pid-in-serverCore fix wouldn't have written one. Probe.
    const reachable = await isDaemonReachable(socketPath)
    if (reachable) {
      console.error(
        'mmd is running but the pid is unknown (started outside `mm daemon start`).',
      )
      console.error(
        "find it with `pgrep -af 'dist/daemon/server.js|src/daemon/server.ts'` and kill manually.",
      )
      process.exitCode = 1
      return
    }
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
    // Pid file absent does NOT prove the daemon is stopped. Anything started
    // outside `mm daemon start` (e.g. `mmd`, `npm run daemon`) leaves no pid
    // file but still binds the socket. Probe before reporting stopped.
    const reachable = await isDaemonReachable(socketPath)
    if (reachable) {
      console.log('mmd: running (pid unknown — started outside `mm daemon start`)')
      console.log(
        "hint: find with `pgrep -af 'dist/daemon/server.js|src/daemon/server.ts'` and kill manually",
      )
      return
    }
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
  try {
    const ping = await call<{ uptime_ms: number; version: string }>(socketPath, '_ping', {})
    console.log(
      `mmd: running (pid ${pid}, uptime ${Math.round(ping.uptime_ms / 1000)}s, version ${ping.version})`,
    )
  } catch (cause) {
    console.log(
      `mmd: running (pid ${pid}) but unresponsive: ${(cause as Error).message}`,
    )
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
