import { getDefaultScanRoots } from '../../config/defaults.js'
import { loadConfig } from '../../config/loadConfig.js'
import type { OcrMode } from '../../config/types.js'
import { openDatabase } from '../../index/db.js'
import { scanFiles } from '../../scanner/fileScanner.js'
import { scanRepos } from '../../repos/gitRepoScanner.js'

type ScanOptions = {
  root?: string[]
  ocrMode?: OcrMode
}

export function runScan(options: ScanOptions = {}): void {
  const roots = resolveRoots(options)
  const ocrMode = resolveOcrMode(options)
  const db = openDatabase()

  const repoCount = scanRepos(db, roots)
  const fileCount = scanFiles(db, roots, { ocrMode })

  db.close()

  console.log(`Scanned roots:`)
  for (const root of roots) {
    console.log(`- ${root}`)
  }
  console.log('')
  console.log(`OCR mode: ${ocrMode}`)
  console.log(`Indexed repos: ${repoCount}`)
  console.log(`Indexed files: ${fileCount}`)
}

function resolveRoots(options: ScanOptions): string[] {
  if (options.root && options.root.length > 0) {
    return uniqueRoots(options.root)
  }

  const config = loadConfig()
  if (config.roots && config.roots.length > 0) {
    return uniqueRoots(config.roots)
  }

  return uniqueRoots(getDefaultScanRoots())
}

function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots.map(root => root.trim()).filter(Boolean))]
}

function resolveOcrMode(options: ScanOptions): OcrMode {
  if (options.ocrMode) {
    return options.ocrMode
  }

  const config = loadConfig()
  return config.ocrMode ?? 'screenshots'
}
