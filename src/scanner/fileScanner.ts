import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { OcrMode } from '../config/types.js'
import { extractTextFromFileResult } from '../extractors/textExtractor.js'
import { upsertTextBlob } from '../index/textBlobs.js'
import { extractImageMetadata, isImageFile } from '../media/imageMetadata.js'
import { extractImageOcr } from '../ocr/imageOcr.js'

const FILE_LIMIT = 5000
const MAX_IMAGE_OCR_BYTES = 6 * 1024 * 1024

export type FileScanOptions = {
  ocrMode?: OcrMode
}

export function scanFiles(
  db: Database.Database,
  roots: string[],
  options: FileScanOptions = {},
): number {
  const ocrMode = options.ocrMode ?? 'screenshots'
  const now = new Date().toISOString()
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

  let count = 0
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
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.pgdata/**',
          '**/.cache/**',
          '**/Library/**',
        ],
      })

      for (const filePath of entries.slice(0, FILE_LIMIT)) {
        const stat = safeStat(filePath)
        if (!stat) continue
        const id = stableId(filePath)
        const imageMetadata = isImageFile(filePath) ? extractImageMetadata(filePath) : null
        const metadataJson = JSON.stringify(imageMetadata?.raw ?? {})

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
          indexed_at: now,
          metadata_json: metadataJson,
        })

        const textExtraction = extractTextFromFileResult(filePath)
        if (textExtraction.success && textExtraction.content && textExtraction.extractorType) {
          upsertTextBlob(db, {
            sourceId: id,
            sourceType: 'file',
            extractorType: textExtraction.extractorType,
            content: textExtraction.content,
          })
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
          }
        }

        count += 1
      }
    }
  })

  tx()
  return count
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

function shouldRunImageOcr(
  metadata: Record<string, unknown>,
  sizeBytes: number,
  ocrMode: OcrMode,
): boolean {
  if (ocrMode === 'off') return false
  if (ocrMode === 'screenshots') return metadata.isScreenshot === true
  return sizeBytes <= MAX_IMAGE_OCR_BYTES
}
