#!/usr/bin/env node
import { createServer } from './serverCore.js'
import { getDaemonSocketPath } from './paths.js'

async function main(): Promise<void> {
  const server = await createServer({ socketPath: getDaemonSocketPath() })
  console.error(`mmd listening on ${server.socketPath}`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`mmd received ${signal}, shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch(err => {
  console.error('mmd failed to start:', err)
  process.exit(1)
})
