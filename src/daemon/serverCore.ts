import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../index/db.js'
import { createHandlers, type Handlers } from './handlers.js'
import {
  encodeMessage,
  MessageDecoder,
  type DaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol.js'

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
            try {
              fs.unlinkSync(opts.socketPath)
            } catch {
              /* ignore */
            }
          }
          resolve()
        })
      }),
  }
}

function isDaemonRequest(message: DaemonMessage): message is DaemonRequest {
  return typeof (message as DaemonRequest).method === 'string'
}

function attachConnection(socket: net.Socket, handlers: Handlers): void {
  const decoder = new MessageDecoder()
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    let messages: DaemonMessage[]
    try {
      messages = decoder.push(chunk as unknown as string)
    } catch (cause) {
      socket.write(encodeMessage(errorResponse('parse-error', -32700, (cause as Error).message)))
      return
    }
    for (const message of messages) {
      if (!isDaemonRequest(message)) continue
      socket.write(encodeMessage(dispatch(message, handlers)))
    }
  })

  socket.on('error', () => {
    /* ignore — client gone */
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

function errorResponse(id: string, code: number, message: string): DaemonResponse {
  return { id, error: { code, message } }
}
