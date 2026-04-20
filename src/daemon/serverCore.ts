import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../index/db.js'
import { isDaemonReachable } from './client.js'
import { createHandlers, type Handlers } from './handlers.js'
import {
  encodeMessage,
  MessageDecoder,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol.js'

export type CreateServerOptions = {
  socketPath: string
  dbPath?: string
  pidPath?: string
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

  const db = openDatabase(opts.dbPath)
  const handlers = createHandlers({ db, startedAt: Date.now() })
  const sockets = new Set<net.Socket>()

  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    attachConnection(socket, handlers)
  })
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

  if (opts.pidPath) {
    try {
      fs.writeFileSync(opts.pidPath, String(process.pid))
    } catch (cause) {
      // Pid write failed after the socket bound; tear the listener back down
      // so we don't leave a half-initialized daemon behind.
      await new Promise<void>(resolve => server.close(() => resolve()))
      db.close()
      if (fs.existsSync(opts.socketPath)) {
        try {
          fs.unlinkSync(opts.socketPath)
        } catch {
          /* ignore */
        }
      }
      throw new Error(
        `failed to write pid file at ${opts.pidPath}: ${(cause as Error).message}`,
      )
    }
  }

  return {
    socketPath: opts.socketPath,
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close(() => {
          db.close()
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
      }),
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
  return typeof m.method === 'string' && m.result === undefined && m.error === undefined
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
