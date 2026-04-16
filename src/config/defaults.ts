import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export const APP_NAME = 'Machine Memory'
export const CLI_NAME = 'mm'
export const DEFAULT_DB_FILENAME = 'machine-memory.sqlite'
export const DEFAULT_CONFIG_FILENAME = 'config.json'

export function getDefaultScanRoots(): string[] {
  const home = os.homedir()
  const candidates = [
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'src'),
    path.join(home, 'workspace'),
    path.join(home, 'work'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures'),
  ]
  return candidates.filter(root => fs.existsSync(root))
}

export function getDefaultDataDir(): string {
  return path.join(homeDir(), '.local', 'share', 'machine-memory')
}

export function getDefaultConfigDir(): string {
  return path.join(homeDir(), '.config', 'machine-memory')
}

export function getDefaultConfigPath(): string {
  return path.join(getDefaultConfigDir(), DEFAULT_CONFIG_FILENAME)
}

export function getDefaultDatabasePath(): string {
  return path.join(getDefaultDataDir(), DEFAULT_DB_FILENAME)
}

function homeDir(): string {
  return os.homedir()
}
