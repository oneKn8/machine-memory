import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { OcrMode } from '../config/types.js'
import { DEFAULT_EXCLUDE_GLOBS } from '../config/defaults.js'
import { expectedTextExtractorType, extractTextFromFileResult } from '../extractors/textExtractor.js'
import { hasTextBlob, upsertTextBlob } from '../index/textBlobs.js'
import { extractImageMetadata, isImageFile } from '../media/imageMetadata.js'
import { extractImageOcr } from '../ocr/imageOcr.js'

const MAX_IMAGE_OCR_BYTES = 6 * 1024 * 1024
const DEFAULT_BATCH_SIZE = 500

const TRACE = process.env.MM_TRACE === '1'
function trace(message: string): void {
  if (TRACE) {
    process.stderr.write(`[mm-trace ${new Date().toISOString()}] ${message}\n`)
  }
}

export type FileScanOptions = {
  ocrMode?: OcrMode
  excludeGlobs?: string[]
  batchSize?: number
  onProgress?: (progress: FileScanProgress) => void
}

export type FileScanProgress = {
  root: string
  processed: number
  total: number
}

export type FileScanSummary = {
  indexedFiles: number
  reusedFiles: number
  textExtractions: number
  metadataExtractions: number
  ocrExtractions: number
}

export function scanFiles(
  db: Database.Database,
  roots: string[],
  options: FileScanOptions = {},
): FileScanSummary {
  const ocrMode = options.ocrMode ?? 'screenshots'
  const excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...(options.excludeGlobs ?? [])]
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const onProgress = options.onProgress

  const insert = db.prepare(`
    INSERT INTO file_records (
      id, path, name, extension, mime_type, size_bytes, created_at, modified_at, accessed_at, source_root, metadata_json, inode, device
    ) VALUES (
      @id, @path, @name, @extension, @mime_type, @size_bytes, @created_at, @modified_at, @accessed_at, @source_root, @metadata_json, @inode, @device
    )
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name,
      extension=excluded.extension,
      mime_type=excluded.mime_type,
      size_bytes=excluded.size_bytes,
      modified_at=excluded.modified_at,
      accessed_at=excluded.accessed_at,
      source_root=excluded.source_root,
      metadata_json=excluded.metadata_json,
      inode=excluded.inode,
      device=excluded.device
  `)
  const findExisting = db.prepare(`
    SELECT metadata_json
    FROM file_records
    WHERE path = ?
  `)

  const summary: FileScanSummary = {
    indexedFiles: 0,
    reusedFiles: 0,
    textExtractions: 0,
    metadataExtractions: 0,
    ocrExtractions: 0,
  }

  // BatchResult is what Pass A produces and Pass B consumes. Pass A runs
  // outside any SQLite transaction so extractor work (which can take
  // multi-second on PDFs) does not block the writer. Pass B runs the
  // entire batch's writes inside a single transaction. Closes F-009 follow-
  // up #1 — the watcher (Slice 3 Tasks 4–5) reuses Pass A's shape over a
  // worker pool; the same writer queue applies Pass B.
  type BatchResult = {
    skipped: boolean                      // safeStat returned null
    fingerprintMatched: boolean
    insertParams?: Record<string, unknown>
    blobs: Array<{ id: string; extractorType: string; content: string; kind: 'text' | 'metadata' | 'ocr' | 'reused-text' }>
    sourceId?: string
  }

  const computeBatchResult = (filePath: string, root: string): BatchResult => {
    const stat = safeStat(filePath)
    if (!stat) return { skipped: true, fingerprintMatched: false, blobs: [] }
    const id = stableId(filePath)
    const scanFingerprint = buildScanFingerprint(filePath, stat)
    const existingRow = findExisting.get(filePath) as { metadata_json: string | null } | undefined
    const existingMetadata = parseMetadata(existingRow?.metadata_json ?? null)
    const blobs: BatchResult['blobs'] = []

    if (existingMetadata.scanFingerprint === scanFingerprint) {
      // Reused-fingerprint path: only re-extract text if the expected blob
      // is missing. hasTextBlob is a SELECT — safe outside a transaction
      // (WAL gives a consistent snapshot per statement).
      const expectedType = expectedTextExtractorType(filePath)
      if (expectedType && !hasTextBlob(db, id, 'file', expectedType)) {
        trace(`text-extract (reused fingerprint) start ${filePath}`)
        const textExtraction = extractTextFromFileResult(filePath)
        trace(`text-extract (reused fingerprint) done ${filePath}`)
        if (textExtraction.success && textExtraction.content && textExtraction.extractorType) {
          blobs.push({ id, extractorType: textExtraction.extractorType, content: textExtraction.content, kind: 'reused-text' })
        }
      }
      return { skipped: false, fingerprintMatched: true, blobs, sourceId: id }
    }

    if (isImageFile(filePath)) trace(`image-metadata start ${filePath}`)
    const imageMetadata = isImageFile(filePath) ? extractImageMetadata(filePath) : null
    if (isImageFile(filePath)) trace(`image-metadata done ${filePath}`)
    const metadata = mergeMetadata(existingMetadata, imageMetadata?.raw ?? {}, {
      scanFingerprint,
      lastIndexedAt: new Date().toISOString(),
      isImage: imageMetadata?.isImage ?? false,
    })

    const insertParams: Record<string, unknown> = {
      id,
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath).replace('.', ''),
      mime_type: imageMetadata?.mimeType ?? null,
      size_bytes: stat.size,
      created_at: new Date(stat.birthtimeMs || Date.now()).toISOString(),
      modified_at: new Date(stat.mtimeMs || Date.now()).toISOString(),
      accessed_at: new Date(stat.atimeMs || Date.now()).toISOString(),
      source_root: root,
      metadata_json: JSON.stringify(metadata),
      // inode + device populated on every scan upsert so subsequent
      // live-path renames can use inode pairing instead of falling
      // back to delete+add. Coerce via Number() to handle BigInt
      // platforms.
      inode: Number(stat.ino),
      device: Number(stat.dev),
    }

    trace(`text-extract start ${filePath}`)
    const textExtraction = extractTextFromFileResult(filePath)
    trace(`text-extract done ${filePath}`)
    if (textExtraction.success && textExtraction.content && textExtraction.extractorType) {
      blobs.push({ id, extractorType: textExtraction.extractorType, content: textExtraction.content, kind: 'text' })
    }

    if (imageMetadata?.summaryText) {
      blobs.push({
        id,
        extractorType: imageMetadata.raw.isScreenshot === true ? 'screenshot_metadata' : 'image_metadata',
        content: imageMetadata.summaryText,
        kind: 'metadata',
      })
    }

    if (imageMetadata?.isImage && shouldRunImageOcr(imageMetadata.raw, stat.size, ocrMode)) {
      trace(`image-ocr start ${filePath}`)
      const imageOcr = extractImageOcr(filePath)
      trace(`image-ocr done ${filePath}`)
      if (imageOcr.success && imageOcr.content && imageOcr.extractorType) {
        blobs.push({ id, extractorType: imageOcr.extractorType, content: imageOcr.content, kind: 'ocr' })
      }
    }

    return { skipped: false, fingerprintMatched: false, insertParams, blobs, sourceId: id }
  }

  const applyBatch = db.transaction((results: BatchResult[]) => {
    for (const r of results) {
      if (r.skipped) continue
      if (r.fingerprintMatched) {
        summary.reusedFiles += 1
      } else if (r.insertParams) {
        insert.run(r.insertParams)
        summary.indexedFiles += 1
      }
      for (const blob of r.blobs) {
        upsertTextBlob(db, {
          sourceId: blob.id,
          sourceType: 'file',
          extractorType: blob.extractorType,
          content: blob.content,
        })
        if (blob.kind === 'text' || blob.kind === 'reused-text') summary.textExtractions += 1
        else if (blob.kind === 'metadata') summary.metadataExtractions += 1
        else if (blob.kind === 'ocr') summary.ocrExtractions += 1
      }
    }
  })

  for (const root of roots) {
    if (!fs.existsSync(root)) continue

    trace(`fast-glob starting on ${root}`)
    const entries = fg.sync(['**/*'], {
      cwd: root,
      onlyFiles: true,
      absolute: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: excludeGlobs,
    })
    trace(`fast-glob returned ${entries.length} entries from ${root}`)

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      // Pass A: extraction outside any transaction.
      const results = batch.map(filePath => computeBatchResult(filePath, root))
      // Pass B: one transaction applies all writes for the batch.
      applyBatch(results)
      const processed = Math.min(i + batch.length, entries.length)
      trace(`committed batch: ${processed}/${entries.length} files in ${root}`)
      onProgress?.({ root, processed, total: entries.length })
    }
  }

  return summary
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function buildScanFingerprint(filePath: string, stat: fs.Stats): string {
  return [
    filePath,
    stat.size,
    Math.floor(stat.mtimeMs),
  ].join(':')
}

function shouldRunImageOcr(
  metadata: Record<string, unknown>,
  sizeBytes: number,
  ocrMode: OcrMode,
): boolean {
  if (ocrMode === 'off') return false
  if (ocrMode === 'screenshots') return metadata.isScreenshot === true
  return sizeBytes <= MAX_IMAGE_OCR_BYTES
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {}

  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mergeMetadata(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    ...next,
    ...runtime,
  }
}
