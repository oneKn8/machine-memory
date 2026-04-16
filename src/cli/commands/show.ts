import { openDatabase } from '../../index/db.js'

type Row = {
  id: string
  path: string
  name: string
  extension: string | null
  modified_at: string | null
  source_root: string | null
}

export function runShow(id: string): void {
  const db = openDatabase()
  const row = db
    .prepare(
      `
      SELECT id, path, name, extension, modified_at, source_root
      FROM file_records
      WHERE id = ?
      `,
    )
    .get(id) as Row | undefined
  db.close()

  if (!row) {
    console.error(`No result found for id: ${id}`)
    process.exitCode = 1
    return
  }

  console.log(`name: ${row.name}`)
  console.log(`path: ${row.path}`)
  console.log(`extension: ${row.extension ?? ''}`)
  console.log(`modified: ${row.modified_at ?? ''}`)
  console.log(`source root: ${row.source_root ?? ''}`)
}

