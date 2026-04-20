import type Database from 'better-sqlite3'

export type BlobSnippet = { extractor_type: string; snippet: string }

export type LoadedRecord =
  | { kind: 'file'; record: Record<string, unknown>; blobs: BlobSnippet[] }
  | { kind: 'repo'; record: Record<string, unknown>; blobs: BlobSnippet[] }
  | null

export function loadRecord(db: Database.Database, id: string): LoadedRecord {
  const fileRow = db
    .prepare(
      `SELECT id, path, name, extension, mime_type, modified_at, source_root, metadata_json
       FROM file_records WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined

  const repoRow = fileRow
    ? undefined
    : (db
        .prepare(
          `SELECT id, root_path, repo_name, remote_url, current_branch, last_commit_at
           FROM repo_records WHERE id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined)

  if (!fileRow && !repoRow) return null

  const blobs = db
    .prepare(
      `SELECT extractor_type, substr(content, 1, 160) AS snippet
       FROM text_blobs WHERE source_id = ? ORDER BY extractor_type ASC`,
    )
    .all(id) as BlobSnippet[]

  return fileRow
    ? { kind: 'file', record: fileRow, blobs }
    : { kind: 'repo', record: repoRow!, blobs }
}
