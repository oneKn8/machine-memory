import { call, isDaemonReachable } from '../../daemon/client.js'
import { getDaemonSocketPath } from '../../daemon/paths.js'
import { openDatabase } from '../../index/db.js'
import { loadRecord, type LoadedRecord } from '../../index/loadRecord.js'

export async function runShow(id: string): Promise<void> {
  const result = await loadResult(id)
  if (!result) {
    console.error(`No result found for id: ${id}`)
    process.exitCode = 1
    return
  }
  printRecord(result)
}

async function loadResult(id: string): Promise<LoadedRecord> {
  const socketPath = getDaemonSocketPath()
  if (await isDaemonReachable(socketPath)) {
    try {
      return await call<LoadedRecord>(socketPath, 'mm_get', { id })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`mmd: ${message}; falling back to direct DB`)
      // fall through to direct DB
    }
  }
  const db = openDatabase()
  try {
    return loadRecord(db, id)
  } finally {
    db.close()
  }
}

function printRecord(result: NonNullable<LoadedRecord>): void {
  if (result.kind === 'file') {
    const fileRow = result.record as {
      name: string
      path: string
      extension: string | null
      mime_type: string | null
      modified_at: string | null
      source_root: string | null
      metadata_json: string | null
    }
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
  } else {
    const repoRow = result.record as {
      repo_name: string
      root_path: string
      remote_url: string | null
      current_branch: string | null
      last_commit_at: string | null
    }
    console.log(`type: repo`)
    console.log(`name: ${repoRow.repo_name}`)
    console.log(`path: ${repoRow.root_path}`)
    console.log(`remote: ${repoRow.remote_url ?? ''}`)
    console.log(`branch: ${repoRow.current_branch ?? ''}`)
    console.log(`last commit: ${repoRow.last_commit_at ?? ''}`)
  }

  if (result.blobs.length > 0) {
    console.log('indexed text:')
    for (const blob of result.blobs) {
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
