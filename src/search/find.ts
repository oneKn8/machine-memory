import type Database from 'better-sqlite3'
import type { SearchResult } from '../types.js'
import { parseQuery } from './queryParser.js'

type Row = {
  id: string
  path: string
  name: string
  modified_at: string | null
}

type RepoRow = {
  id: string
  root_path: string
  repo_name: string
  last_commit_at: string | null
  remote_url: string | null
}

type TextRow = {
  source_id: string
  source_type: 'file' | 'repo'
  content: string
}

export function findMatches(
  db: Database.Database,
  rawQuery: string,
): SearchResult[] {
  const parsed = parseQuery(rawQuery)
  if (!parsed.normalizedQuery) return []

  const fileRows = db
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

  const repoRows = db
    .prepare(
      `
      SELECT id, root_path, repo_name, last_commit_at, remote_url
      FROM repo_records
      WHERE lower(repo_name) LIKE ?
         OR lower(ifnull(remote_url, '')) LIKE ?
      ORDER BY last_commit_at DESC
      LIMIT 10
      `,
    )
    .all(`%${parsed.normalizedQuery}%`, `%${parsed.normalizedQuery}%`) as RepoRow[]

  const textRows = db
    .prepare(
      `
      SELECT source_id, source_type, snippet(text_blobs_fts, 3, '[', ']', ' … ', 12) AS content
      FROM text_blobs_fts
      WHERE text_blobs_fts MATCH ?
      LIMIT 10
      `,
    )
    .all(toFtsQuery(parsed.normalizedQuery)) as TextRow[]

  const results = new Map<string, SearchResult>()

  for (const row of fileRows) {
    const score = scoreStringMatch(parsed.normalizedQuery, `${row.name} ${row.path}`)
    results.set(row.id, {
      resultId: row.id,
      resultType: 'file',
      title: row.name,
      path: row.path,
      whyMatched: 'Matched file name or path text',
      score,
      lastModified: row.modified_at ?? undefined,
    })
  }

  for (const row of repoRows) {
    const score = scoreStringMatch(
      parsed.normalizedQuery,
      `${row.repo_name} ${row.root_path} ${row.remote_url ?? ''}`,
      120,
    )
    results.set(row.id, {
      resultId: row.id,
      resultType: 'repo',
      title: row.repo_name,
      path: row.root_path,
      whyMatched: row.remote_url
        ? `Matched repo name or remote URL (${row.remote_url})`
        : 'Matched repo name',
      score,
      lastModified: row.last_commit_at ?? undefined,
    })
  }

  for (const row of textRows) {
    if (results.has(row.source_id)) continue
    const target = row.source_type === 'repo'
      ? db
          .prepare(
            `
            SELECT id, root_path AS path, repo_name AS title, last_commit_at AS modified_at
            FROM repo_records
            WHERE id = ?
            `,
          )
          .get(row.source_id) as
          | { id: string; path: string; title: string; modified_at: string | null }
          | undefined
      : db
          .prepare(
            `
            SELECT id, path, name AS title, modified_at
            FROM file_records
            WHERE id = ?
            `,
          )
          .get(row.source_id) as
          | { id: string; path: string; title: string; modified_at: string | null }
          | undefined

    if (!target) continue

    results.set(row.source_id, {
      resultId: target.id,
      resultType: row.source_type,
      title: target.title,
      path: target.path,
      whyMatched: `Matched indexed text: ${row.content}`,
      score: row.source_type === 'repo' ? 90 : 80,
      lastModified: target.modified_at ?? undefined,
    })
  }

  return [...results.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
}

function toFtsQuery(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `${escapeFtsToken(token)}*`)
    .join(' OR ')
}

function escapeFtsToken(token: string): string {
  return token.replace(/[^a-z0-9_-]/gi, '')
}

function scoreStringMatch(
  query: string,
  haystack: string,
  baseScore = 100,
): number {
  const normalizedHaystack = normalizeSeparators(haystack.toLowerCase())
  const normalizedQuery = normalizeSeparators(query.toLowerCase())

  if (normalizedHaystack.includes(normalizedQuery)) {
    return baseScore + 40
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const tokenHits = tokens.filter(token => normalizedHaystack.includes(token)).length
  return baseScore + tokenHits * 5
}

function normalizeSeparators(value: string): string {
  return value.replace(/[-_/\\.]+/g, ' ')
}
