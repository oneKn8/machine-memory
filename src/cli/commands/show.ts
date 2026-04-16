import { openDatabase } from '../../index/db.js'

type Row = {
  id: string
  path: string
  name: string
  extension: string | null
  mime_type: string | null
  modified_at: string | null
  source_root: string | null
  metadata_json: string | null
}

export function runShow(id: string): void {
  const db = openDatabase()
  const row = db
    .prepare(
      `
      SELECT id, path, name, extension, mime_type, modified_at, source_root, metadata_json
      FROM file_records
      WHERE id = ?
      `,
    )
    .get(id) as Row | undefined

  const textBlobs = db
    .prepare(
      `
      SELECT extractor_type, substr(content, 1, 160) AS snippet
      FROM text_blobs
      WHERE source_id = ? AND source_type = 'file'
      ORDER BY extractor_type ASC
      `,
    )
    .all(id) as Array<{ extractor_type: string; snippet: string }>
  db.close()

  if (!row) {
    console.error(`No result found for id: ${id}`)
    process.exitCode = 1
    return
  }

  console.log(`name: ${row.name}`)
  console.log(`path: ${row.path}`)
  console.log(`extension: ${row.extension ?? ''}`)
  if (row.mime_type) {
    console.log(`mime: ${row.mime_type}`)
  }
  console.log(`modified: ${row.modified_at ?? ''}`)
  console.log(`source root: ${row.source_root ?? ''}`)

  const metadata = parseMetadata(row.metadata_json)
  if (Object.keys(metadata).length > 0) {
    console.log(`metadata: ${JSON.stringify(metadata)}`)
  }

  if (textBlobs.length > 0) {
    console.log('indexed text:')
    for (const blob of textBlobs) {
      console.log(`- ${blob.extractor_type}: ${blob.snippet}`)
    }
  }
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
