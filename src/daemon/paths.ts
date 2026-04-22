import path from 'node:path'
import { getDefaultDataDir } from '../config/defaults.js'

function dataDir(): string {
  return process.env.MM_DATA_DIR ?? getDefaultDataDir()
}

export function getDaemonSocketPath(): string {
  return path.join(dataDir(), 'mmd.sock')
}

export function getDaemonPidPath(): string {
  return path.join(dataDir(), 'mmd.pid')
}

export function getMcpUrlPath(): string {
  return path.join(dataDir(), 'mcp.url')
}
