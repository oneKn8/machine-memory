import type Database from 'better-sqlite3'
import type { SearchResult } from '../types.js'
import { parseQuery } from './queryParser.js'

type Row = {
  id: string
  path: string
  name: string
  modified_at: string | null
}

export function findMatches(
  db: Database.Database,
  rawQuery: string,
): SearchResult[] {
  const parsed = parseQuery(rawQuery)
  const rows = db
    .prepare(
      `
      SELECT id, path, name, modified_at
      FROM file_records
      WHERE lower(name) LIKE ?
         OR lower(path) LIKE ?
      ORDER BY modified_at DESC
      LIMIT 10
      `,
    )
    .all(`%${parsed.normalizedQuery}%`, `%${parsed.normalizedQuery}%`) as Row[]

  return rows.map(row => ({
    resultId: row.id,
    resultType: 'file',
    title: row.name,
    path: row.path,
    whyMatched: 'Matched file name or path text',
    score: 1,
    lastModified: row.modified_at ?? undefined,
  }))
}

