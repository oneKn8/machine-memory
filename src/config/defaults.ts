import os from 'node:os'
import path from 'node:path'

export const APP_NAME = 'Machine Memory'
export const CLI_NAME = 'mm'
export const DEFAULT_DB_FILENAME = 'machine-memory.sqlite'

export function getDefaultScanRoots(): string[] {
  const home = os.homedir()
  return [
    path.join(home, 'projects'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures'),
  ]
}

export function getDefaultDataDir(): string {
  return path.join(homeDir(), '.local', 'share', 'machine-memory')
}

export function getDefaultDatabasePath(): string {
  return path.join(getDefaultDataDir(), DEFAULT_DB_FILENAME)
}

function homeDir(): string {
  return os.homedir()
}

