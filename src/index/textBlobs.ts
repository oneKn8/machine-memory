import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export type TextBlobInput = {
  sourceId: string
  sourceType: 'file' | 'repo'
  extractorType: string
  content: string
}

export function upsertTextBlob(
  db: Database.Database,
  input: TextBlobInput,
): void {
  const trimmed = input.content.trim()
  if (!trimmed) return

  const id = stableId(
    `${input.sourceId}:${input.sourceType}:${input.extractorType}:${trimmed}`,
  )

  db.prepare(
    `
    DELETE FROM text_blobs
    WHERE source_id = ? AND source_type = ? AND extractor_type = ?
    `,
  ).run(input.sourceId, input.sourceType, input.extractorType)

  db.prepare(
    `
    DELETE FROM text_blobs_fts
    WHERE source_id = ? AND source_type = ? AND extractor_type = ?
    `,
  ).run(input.sourceId, input.sourceType, input.extractorType)

  db.prepare(
    `
    INSERT INTO text_blobs (id, source_id, source_type, extractor_type, content, created_at)
    VALUES (@id, @source_id, @source_type, @extractor_type, @content, @created_at)
    `,
  ).run({
    id,
    source_id: input.sourceId,
    source_type: input.sourceType,
    extractor_type: input.extractorType,
    content: trimmed,
    created_at: new Date().toISOString(),
  })

  db.prepare(
    `
    INSERT INTO text_blobs_fts (source_id, source_type, extractor_type, content)
    VALUES (@source_id, @source_type, @extractor_type, @content)
    `,
  ).run({
    source_id: input.sourceId,
    source_type: input.sourceType,
    extractor_type: input.extractorType,
    content: trimmed,
  })
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

