import fs from 'node:fs'
import path from 'node:path'
import { getDefaultDataDir, getDefaultDatabasePath } from './defaults.js'

export function ensureDataDir(): string {
  const dir = getDefaultDataDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveDatabasePath(customPath?: string): string {
  if (customPath) {
    const parent = path.dirname(customPath)
    fs.mkdirSync(parent, { recursive: true })
    return customPath
  }
  ensureDataDir()
  return getDefaultDatabasePath()
}

