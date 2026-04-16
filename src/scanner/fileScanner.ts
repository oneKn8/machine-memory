import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { extractTextFromFile } from '../extractors/textExtractor.js'
import { upsertTextBlob } from '../index/textBlobs.js'

const FILE_LIMIT = 5000

export function scanFiles(db: Database.Database, roots: string[]): number {
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO file_records (
      id, path, name, extension, size_bytes, created_at, modified_at, accessed_at, source_root
    ) VALUES (
      @id, @path, @name, @extension, @size_bytes, @created_at, @modified_at, @accessed_at, @source_root
    )
    ON CONFLICT(path) DO UPDATE SET
      name=excluded.name,
      extension=excluded.extension,
      size_bytes=excluded.size_bytes,
      created_at=excluded.created_at,
      modified_at=excluded.modified_at,
      accessed_at=excluded.accessed_at,
      source_root=excluded.source_root
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

        insert.run({
          id: stableId(filePath),
          path: filePath,
          name: path.basename(filePath),
          extension: path.extname(filePath).replace('.', ''),
          size_bytes: stat.size,
          created_at: new Date(stat.birthtimeMs || Date.now()).toISOString(),
          modified_at: new Date(stat.mtimeMs || Date.now()).toISOString(),
          accessed_at: new Date(stat.atimeMs || Date.now()).toISOString(),
          source_root: root,
          indexed_at: now,
        })

        const extractedText = extractTextFromFile(filePath)
        if (extractedText) {
          upsertTextBlob(db, {
            sourceId: stableId(filePath),
            sourceType: 'file',
            extractorType: 'text',
            content: extractedText,
          })
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
