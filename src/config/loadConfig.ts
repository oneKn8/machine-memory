import fs from 'node:fs'
import { getDefaultConfigPath } from './defaults.js'
import type { OcrMode } from './types.js'

export type MachineMemoryConfig = {
  roots?: string[]
  ocrMode?: OcrMode
}

export function loadConfig(): MachineMemoryConfig {
  const configPath = getDefaultConfigPath()
  if (!fs.existsSync(configPath)) {
    return {}
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as MachineMemoryConfig
    return parsed ?? {}
  } catch {
    return {}
  }
}
