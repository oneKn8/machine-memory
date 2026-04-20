import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { encodeMessage, MessageDecoder, type DaemonResponse } from './protocol.js'

export class DaemonCallError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'DaemonCallError'
    this.code = code
  }
}

export type CallOptions = { timeoutMs?: number }

export async function isDaemonReachable(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false
  // TCP-style connect probe rather than fs.statSync(...).isSocket(): we want
  // proof the server is actually accepting connections, not just that a
  // socket file exists (which can be stale after an unclean shutdown).
  return new Promise<boolean>(resolve => {
    const probe = net.createConnection(socketPath)
    const settle = (value: boolean): void => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(value)
    }
    probe.once('connect', () => settle(true))
    probe.once('error', () => settle(false))
    setTimeout(() => settle(false), 250)
  })
}

export function call<R = unknown>(
  socketPath: string,
  method: string,
  params: unknown,
  opts: CallOptions = {},
): Promise<R> {
  const timeoutMs = opts.timeoutMs ?? 5000
  return new Promise<R>((resolve, reject) => {
    const id = crypto.randomUUID()
    const client = net.createConnection(socketPath)
    const decoder = new MessageDecoder()
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.removeAllListeners()
      client.destroy()
      fn()
    }
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`daemon call timed out after ${timeoutMs}ms: ${method}`)))
    }, timeoutMs)
    client.setEncoding('utf8')
    client.on('data', chunk => {
      try {
        // setEncoding('utf8') guarantees chunk is a string at runtime;
        // String() satisfies tsc's NonSharedBuffer | string union without a double cast.
        const messages = decoder.push(String(chunk)) as DaemonResponse<R>[]
        const match = messages.find(m => m.id === id)
        if (!match) return
        if (match.error) {
          settle(() => reject(new DaemonCallError(match.error!.code, match.error!.message)))
          return
        }
        settle(() => resolve(match.result as R))
      } catch (cause) {
        settle(() => reject(cause))
      }
    })
    client.on('error', err => settle(() => reject(err)))
    client.on('connect', () => {
      client.write(encodeMessage({ id, method, params }))
    })
  })
}
