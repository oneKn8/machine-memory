import type Database from 'better-sqlite3'
import type { SearchResult } from '../types.js'
import { parseQuery } from './queryParser.js'

type Row = {
  id: string
  path: string
  name: string
  extension: string | null
  mime_type: string | null
  metadata_json: string | null
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
  extractor_type: string
  content: string
}

export function findMatches(
  db: Database.Database,
  rawQuery: string,
): SearchResult[] {
  const parsed = parseQuery(rawQuery)
  if (!parsed.normalizedQuery) return []
  const queryTokens = parsed.normalizedQuery.split(/\s+/).filter(Boolean)

  const fileRows = db
    .prepare(
      buildFileSearchSql(queryTokens),
    )
    .all(...buildLikeParams(queryTokens)) as Row[]

  const repoRows = db
    .prepare(
      buildRepoSearchSql(queryTokens),
    )
    .all(...buildRepoLikeParams(queryTokens)) as RepoRow[]

  const textRows = searchTextRows(db, queryTokens)

  const results = new Map<string, SearchResult>()

  for (const row of fileRows) {
    const metadata = parseMetadata(row.metadata_json)
    const score =
      scoreStringMatch(parsed.normalizedQuery, `${row.name} ${row.path}`) +
      scoreSourceHints(parsed.sourceHints, metadata, row.extension, row.path)
    results.set(row.id, {
      resultId: row.id,
      resultType: 'file',
      title: row.name,
      path: row.path,
      whyMatched: describeFileMatch(metadata),
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
    const existing = results.get(row.source_id)
    if (existing) {
      existing.whyMatched = mergeMatchReasons(
        existing.whyMatched,
        `Matched ${describeTextBlobType(row.extractor_type)}: ${row.content}`,
      )
      existing.score += scoreBlobSourceHint(parsed.sourceHints, row.extractor_type) + 10
      continue
    }
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
      whyMatched: `Matched ${describeTextBlobType(row.extractor_type)}: ${row.content}`,
      score:
        row.source_type === 'repo'
          ? 90
          : 80 + scoreBlobSourceHint(parsed.sourceHints, row.extractor_type),
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

function toStrictFtsQuery(tokens: string[]): string {
  return tokens.map(token => `${escapeFtsToken(token)}*`).join(' AND ')
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

function searchTextRows(db: Database.Database, queryTokens: string[]): TextRow[] {
  const queryRows = db.prepare(
    `
    SELECT source_id, source_type, extractor_type, snippet(text_blobs_fts, 3, '[', ']', ' … ', 12) AS content
    FROM text_blobs_fts
    WHERE text_blobs_fts MATCH ?
    LIMIT 15
    `,
  )

  const strictTokens = queryTokens
    .map(escapeFtsToken)
    .filter(Boolean)

  if (strictTokens.length > 0) {
    const strictRows = queryRows.all(toStrictFtsQuery(strictTokens)) as TextRow[]
    if (strictRows.length > 0) {
      return strictRows
    }
  }

  return queryRows.all(toFtsQuery(queryTokens.join(' '))) as TextRow[]
}

function buildFileSearchSql(queryTokens: string[]): string {
  const tokenClauses = queryTokens
    .map(() => '(lower(name) LIKE ? OR lower(path) LIKE ?)')
    .join(' OR ')

  return `
    SELECT id, path, name, extension, mime_type, metadata_json, modified_at
    FROM file_records
    WHERE ${tokenClauses}
    ORDER BY modified_at DESC
    LIMIT 25
  `
}

function buildRepoSearchSql(queryTokens: string[]): string {
  const tokenClauses = queryTokens
    .map(() => '(lower(repo_name) LIKE ? OR lower(ifnull(remote_url, \'\')) LIKE ? OR lower(root_path) LIKE ?)')
    .join(' OR ')

  return `
    SELECT id, root_path, repo_name, last_commit_at, remote_url
    FROM repo_records
    WHERE ${tokenClauses}
    ORDER BY last_commit_at DESC
    LIMIT 25
  `
}

function buildLikeParams(queryTokens: string[]): string[] {
  return queryTokens.flatMap(token => {
    const pattern = `%${token}%`
    return [pattern, pattern]
  })
}

function buildRepoLikeParams(queryTokens: string[]): string[] {
  return queryTokens.flatMap(token => {
    const pattern = `%${token}%`
    return [pattern, pattern, pattern]
  })
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

function scoreSourceHints(
  sourceHints: string[],
  metadata: Record<string, unknown>,
  extension: string | null,
  filePath: string,
): number {
  let score = 0
  const fileCategory = metadata.fileCategory
  const isScreenshot = metadata.isScreenshot === true
  const normalizedExtension = extension?.toLowerCase() ?? ''

  if (sourceHints.includes('image') && fileCategory === 'image') {
    score += 20
  }

  if (sourceHints.includes('screenshot') && isScreenshot) {
    score += 30
  }

  if (sourceHints.includes('pdf') && normalizedExtension === 'pdf') {
    score += 20
  }

  if (sourceHints.includes('download') && filePath.toLowerCase().includes('/downloads/')) {
    score += 20
  }

  return score
}

function scoreBlobSourceHint(sourceHints: string[], extractorType: string): number {
  if (sourceHints.includes('screenshot') && extractorType.startsWith('screenshot_')) {
    return 20
  }

  if (sourceHints.includes('image') && extractorType.startsWith('image_')) {
    return 15
  }

  if (sourceHints.includes('pdf') && extractorType === 'application/pdf') {
    return 15
  }

  return 0
}

function describeFileMatch(metadata: Record<string, unknown>): string {
  if (metadata.isScreenshot === true) {
    return 'Matched screenshot file name or path'
  }

  if (metadata.fileCategory === 'image') {
    return 'Matched image file name or path'
  }

  return 'Matched file name or path text'
}

function describeTextBlobType(extractorType: string): string {
  switch (extractorType) {
    case 'image_metadata':
      return 'image metadata'
    case 'screenshot_metadata':
      return 'screenshot metadata'
    case 'image_ocr':
      return 'image OCR text'
    case 'screenshot_ocr':
      return 'screenshot OCR text'
    case 'application/pdf':
      return 'PDF text'
    case 'text/package-manifest':
      return 'package manifest text'
    case 'repo_summary':
      return 'repo summary text'
    default:
      return 'indexed text'
  }
}

function mergeMatchReasons(primary: string, secondary: string): string {
  if (primary.includes(secondary)) return primary
  return `${primary}; ${secondary}`
}
