import { openDatabase } from '../../index/db.js'

type FileRow = {
  id: string
  path: string
  name: string
  extension: string | null
  mime_type: string | null
  modified_at: string | null
  source_root: string | null
  metadata_json: string | null
}

type RepoRow = {
  id: string
  root_path: string
  repo_name: string
  remote_url: string | null
  current_branch: string | null
  last_commit_at: string | null
}

export function runShow(id: string): void {
  const db = openDatabase()
  const fileRow = db
    .prepare(
      `
      SELECT id, path, name, extension, mime_type, modified_at, source_root, metadata_json
      FROM file_records
      WHERE id = ?
      `,
    )
    .get(id) as FileRow | undefined

  const repoRow = fileRow
    ? undefined
    : db
        .prepare(
          `
          SELECT id, root_path, repo_name, remote_url, current_branch, last_commit_at
          FROM repo_records
          WHERE id = ?
          `,
        )
        .get(id) as RepoRow | undefined

  const textBlobs = db
    .prepare(
      `
      SELECT extractor_type, substr(content, 1, 160) AS snippet
      FROM text_blobs
      WHERE source_id = ?
      ORDER BY extractor_type ASC
      `,
    )
    .all(id) as Array<{ extractor_type: string; snippet: string }>
  db.close()

  if (!fileRow && !repoRow) {
    console.error(`No result found for id: ${id}`)
    process.exitCode = 1
    return
  }

  if (fileRow) {
    console.log(`type: file`)
    console.log(`name: ${fileRow.name}`)
    console.log(`path: ${fileRow.path}`)
    console.log(`extension: ${fileRow.extension ?? ''}`)
    if (fileRow.mime_type) {
      console.log(`mime: ${fileRow.mime_type}`)
    }
    console.log(`modified: ${fileRow.modified_at ?? ''}`)
    console.log(`source root: ${fileRow.source_root ?? ''}`)

    const metadata = parseMetadata(fileRow.metadata_json)
    if (Object.keys(metadata).length > 0) {
      console.log(`metadata: ${JSON.stringify(metadata)}`)
    }
  }

  if (repoRow) {
    console.log(`type: repo`)
    console.log(`name: ${repoRow.repo_name}`)
    console.log(`path: ${repoRow.root_path}`)
    console.log(`remote: ${repoRow.remote_url ?? ''}`)
    console.log(`branch: ${repoRow.current_branch ?? ''}`)
    console.log(`last commit: ${repoRow.last_commit_at ?? ''}`)
  }

  if (textBlobs.length > 0) {
    console.log('indexed text:')
    for (const blob of textBlobs) {
      console.log(`- ${blob.extractor_type}: ${normalizeSnippet(blob.snippet)}`)
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

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
