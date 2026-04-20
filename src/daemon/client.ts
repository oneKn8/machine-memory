import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { encodeMessage, MessageDecoder, type DaemonResponse } from './protocol.js'

export async function isDaemonReachable(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false
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

export function call<R = unknown>(socketPath: string, method: string, params: unknown): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const id = crypto.randomUUID()
    const client = net.createConnection(socketPath)
    const decoder = new MessageDecoder()
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      client.destroy()
      fn()
    }
    client.setEncoding('utf8')
    client.on('data', chunk => {
      try {
        const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
        const messages = decoder.push(text) as DaemonResponse<R>[]
        const match = messages.find(m => m.id === id)
        if (!match) return
        if (match.error) {
          settle(() => reject(new Error(match.error!.message)))
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
