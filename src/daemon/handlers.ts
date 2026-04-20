import type Database from 'better-sqlite3'
import { findMatches } from '../search/find.js'
import { loadRecord, type LoadedRecord } from '../index/loadRecord.js'
import type { SearchResult } from '../types.js'

export type FindParams = { query: string }
export type GetParams = { id: string }
export type RecentParams = { since?: string; limit?: number }

export type GetResult = LoadedRecord
export type { BlobSnippet } from '../index/loadRecord.js'

export type PingResult = { ok: true; pid: number; uptime_ms: number; version: string }

export type Handlers = {
  mm_find: (params: FindParams) => SearchResult[]
  mm_get: (params: GetParams) => GetResult
  mm_recent: (params: RecentParams) => SearchResult[]
  _ping: () => PingResult
}

export type HandlerContext = {
  db: Database.Database
  startedAt: number
  version?: string
}

export function createHandlers(ctx: HandlerContext): Handlers {
  return {
    mm_find: ({ query }) => findMatches(ctx.db, query),
    mm_get: ({ id }) => loadRecord(ctx.db, id),
    mm_recent: ({ since, limit }) => loadRecent(ctx.db, since, limit),
    _ping: () => ({
      ok: true,
      pid: process.pid,
      uptime_ms: Date.now() - ctx.startedAt,
      version: ctx.version ?? '0.1.0',
    }),
  }
}

function loadRecent(
  db: Database.Database,
  since: string | undefined,
  limit: number | undefined,
): SearchResult[] {
  const cap = Math.min(Math.max(limit ?? 20, 1), 100)
  const sinceClause = since ? 'WHERE modified_at >= ?' : ''
  const params = since ? [since, cap] : [cap]
  const rows = db
    .prepare(
      `SELECT id, path, name, modified_at
       FROM file_records ${sinceClause}
       ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(...params) as Array<{ id: string; path: string; name: string; modified_at: string | null }>
  return rows.map(row => ({
    resultId: row.id,
    resultType: 'file' as const,
    title: row.name,
    path: row.path,
    whyMatched: 'Recently modified',
    score: 0,
    lastModified: row.modified_at ?? undefined,
  }))
}
