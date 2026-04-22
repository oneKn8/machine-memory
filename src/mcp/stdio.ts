#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.js'
import { isDaemonReachable, call } from '../daemon/client.js'
import { getDaemonSocketPath } from '../daemon/paths.js'

async function main(): Promise<void> {
  const socketPath = getDaemonSocketPath()
  if (!(await isDaemonReachable(socketPath))) {
    process.stderr.write(
      `mmd-mcp: daemon not running at ${socketPath}. Start it with \`mm daemon start\` (or run \`mmd\` directly), then re-launch this MCP server.\n`,
    )
    process.exit(1)
  }
  const daemon = {
    call: async <R = unknown>(method: string, params: unknown): Promise<R> =>
      call<R>(socketPath, method, params),
  }
  const server = createMcpServer({ daemon })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`mmd-mcp: ${sig} received, shutting down\n`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch(err => {
  process.stderr.write(`mmd-mcp: failed to start: ${(err as Error).message}\n`)
  process.exit(1)
})
