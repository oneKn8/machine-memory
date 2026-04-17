import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { OcrMode } from '../config/types.js'
import { DEFAULT_EXCLUDE_GLOBS } from '../config/defaults.js'
import { extractTextFromFileResult } from '../extractors/textExtractor.js'
import { upsertTextBlob } from '../index/textBlobs.js'
import { extractImageMetadata, isImageFile } from '../media/imageMetadata.js'
import { extractImageOcr } from '../ocr/imageOcr.js'

const MAX_IMAGE_OCR_BYTES = 6 * 1024 * 1024

export type FileScanOptions = {
  ocrMode?: OcrMode
  excludeGlobs?: string[]
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
  const insert = db.prepare(`
    INSERT INTO file_records (
      id, path, name, extension, mime_type, size_bytes, created_at, modified_at, accessed_at, source_root, metadata_json
    ) VALUES (
      @id, @path, @name, @extension, @mime_type, @size_bytes, @created_at, @modified_at, @accessed_at, @source_root, @metadata_json
    )
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name,
      extension=excluded.extension,
      mime_type=excluded.mime_type,
      size_bytes=excluded.size_bytes,
      created_at=excluded.created_at,
      modified_at=excluded.modified_at,
      accessed_at=excluded.accessed_at,
      source_root=excluded.source_root,
      metadata_json=excluded.metadata_json
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
  const tx = db.transaction(() => {
    for (const root of roots) {
      if (!fs.existsSync(root)) continue

      const entries = fg.sync(['**/*'], {
        cwd: root,
        onlyFiles: true,
        absolute: true,
        dot: false,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: excludeGlobs,
      })

      for (const filePath of entries) {
        const stat = safeStat(filePath)
        if (!stat) continue
        const id = stableId(filePath)
        const scanFingerprint = buildScanFingerprint(filePath, stat)
        const existingRow = findExisting.get(filePath) as { metadata_json: string | null } | undefined
        const existingMetadata = parseMetadata(existingRow?.metadata_json ?? null)

        if (existingMetadata.scanFingerprint === scanFingerprint) {
          summary.reusedFiles += 1
          continue
        }

        const imageMetadata = isImageFile(filePath) ? extractImageMetadata(filePath) : null
        const metadata = mergeMetadata(existingMetadata, imageMetadata?.raw ?? {}, {
          scanFingerprint,
          lastIndexedAt: new Date().toISOString(),
          isImage: imageMetadata?.isImage ?? false,
        })
        const metadataJson = JSON.stringify(metadata)

        insert.run({
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
          metadata_json: metadataJson,
        })
        summary.indexedFiles += 1

        const textExtraction = extractTextFromFileResult(filePath)
        if (textExtraction.success && textExtraction.content && textExtraction.extractorType) {
          upsertTextBlob(db, {
            sourceId: id,
            sourceType: 'file',
            extractorType: textExtraction.extractorType,
            content: textExtraction.content,
          })
          summary.textExtractions += 1
        }

        if (imageMetadata?.summaryText) {
          upsertTextBlob(db, {
            sourceId: id,
            sourceType: 'file',
            extractorType: imageMetadata.raw.isScreenshot === true
              ? 'screenshot_metadata'
              : 'image_metadata',
            content: imageMetadata.summaryText,
          })
          summary.metadataExtractions += 1
        }

        if (imageMetadata?.isImage && shouldRunImageOcr(imageMetadata.raw, stat.size, ocrMode)) {
          const imageOcr = extractImageOcr(filePath)
          if (imageOcr.success && imageOcr.content && imageOcr.extractorType) {
            upsertTextBlob(db, {
              sourceId: id,
              sourceType: 'file',
              extractorType: imageOcr.extractorType,
              content: imageOcr.content,
            })
            summary.ocrExtractions += 1
          }
        }
      }
    }
  })

  tx()
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
