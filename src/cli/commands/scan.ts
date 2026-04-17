import { DEFAULT_EXCLUDE_GLOBS, getDefaultScanRoots } from '../../config/defaults.js'
import { loadConfig } from '../../config/loadConfig.js'
import type { MachineMemoryConfig, OcrMode } from '../../config/types.js'
import { openDatabase } from '../../index/db.js'
import { scanFiles } from '../../scanner/fileScanner.js'
import { scanRepos } from '../../repos/gitRepoScanner.js'

type ScanOptions = {
  root?: string[]
  ocrMode?: OcrMode
  exclude?: string[]
}

export function runScan(options: ScanOptions = {}): void {
  const roots = resolveRoots(options)
  const config = loadConfig()
  const ocrMode = resolveOcrMode(options)
  const excludeGlobs = resolveExcludeGlobs(config, options)
  const db = openDatabase()

  const repoCount = scanRepos(db, roots)
  const fileSummary = scanFiles(db, roots, { ocrMode, excludeGlobs })

  db.close()

  console.log(`Scanned roots:`)
  for (const root of roots) {
    console.log(`- ${root}`)
  }
  console.log('')
  console.log(`OCR mode: ${ocrMode}`)
  console.log(`Exclude globs: ${excludeGlobs.length}`)
  console.log(`Indexed repos: ${repoCount}`)
  console.log(`Indexed files: ${fileSummary.indexedFiles}`)
  console.log(`Reused unchanged files: ${fileSummary.reusedFiles}`)
  console.log(`Text extractions: ${fileSummary.textExtractions}`)
  console.log(`Metadata extractions: ${fileSummary.metadataExtractions}`)
  console.log(`OCR extractions: ${fileSummary.ocrExtractions}`)
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

function resolveExcludeGlobs(
  config: MachineMemoryConfig,
  options: ScanOptions,
): string[] {
  const configured = config.excludeGlobs ?? []
  const cli = options.exclude ?? []
  return [...new Set([...DEFAULT_EXCLUDE_GLOBS, ...configured, ...cli])]
}
