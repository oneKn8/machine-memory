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
  const fuzzyFileRows = findFuzzyFileRows(db, parsed.normalizedQuery)
  const fuzzyRepoRows = findFuzzyRepoRows(db, parsed.normalizedQuery)

  const results = new Map<string, SearchResult>()

  for (const row of fileRows) {
    const metadata = parseMetadata(row.metadata_json)
    const score =
      scoreStringMatch(parsed.normalizedQuery, `${row.name} ${row.path}`) +
      scoreSourceHints(parsed.sourceHints, metadata, row.extension, row.path) +
      scorePathQuality(row.path, 'file')
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
    ) + scorePathQuality(row.root_path, 'repo')
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
      existing.score += 35 + scoreBlobSourceHint(parsed.sourceHints, row.extractor_type)
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
          ? 135 + scoreBlobSourceHint(parsed.sourceHints, row.extractor_type) + scorePathQuality(target.path, 'repo')
          : 125 + scoreBlobSourceHint(parsed.sourceHints, row.extractor_type) + scorePathQuality(target.path, 'file'),
      lastModified: target.modified_at ?? undefined,
    })
  }

  for (const row of fuzzyFileRows) {
    if (results.has(row.id)) continue

    const metadata = parseMetadata(row.metadata_json)
    const similarity = fuzzySimilarity(parsed.normalizedQuery, `${row.name} ${stripExtension(row.name)}`)
    if (similarity < 0.72) continue

    results.set(row.id, {
      resultId: row.id,
      resultType: 'file',
      title: row.name,
      path: row.path,
      whyMatched: `Matched similar file name or path (${Math.round(similarity * 100)}% name similarity)`,
      score: 70 + Math.round(similarity * 50) + scoreSourceHints(parsed.sourceHints, metadata, row.extension, row.path) + scorePathQuality(row.path, 'file'),
      lastModified: row.modified_at ?? undefined,
    })
  }

  for (const row of fuzzyRepoRows) {
    if (results.has(row.id)) continue

    const similarity = fuzzySimilarity(parsed.normalizedQuery, row.repo_name)
    if (similarity < 0.72) continue

    results.set(row.id, {
      resultId: row.id,
      resultType: 'repo',
      title: row.repo_name,
      path: row.root_path,
      whyMatched: row.remote_url
        ? `Matched similar repo name (${Math.round(similarity * 100)}% similarity) and remote URL (${row.remote_url})`
        : `Matched similar repo name (${Math.round(similarity * 100)}% similarity)`,
      score: 72 + Math.round(similarity * 55) + scorePathQuality(row.root_path, 'repo'),
      lastModified: row.last_commit_at ?? undefined,
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
    return 28
  }

  if (sourceHints.includes('image') && extractorType.startsWith('image_')) {
    return 24
  }

  if (sourceHints.includes('image') && extractorType.startsWith('screenshot_')) {
    return 18
  }

  if (sourceHints.includes('pdf') && extractorType === 'application/pdf') {
    return 24
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
    case 'application/docx':
      return 'DOCX text'
    case 'text/package-manifest':
      return 'package manifest text'
    case 'repo_summary':
      return 'repo summary text'
    default:
      return 'indexed text'
  }
}

function scorePathQuality(pathValue: string, resultType: 'file' | 'repo'): number {
  const normalizedPath = pathValue.toLowerCase()
  let score = 0

  const noisySegments = [
    '/node_modules/',
    '/.git/',
    '/__pycache__/',
    '/.cache/',
    '/.venv/',
    '/venv/',
    '/vendor/',
    '/dist/',
    '/build/',
    '/.next/',
    '/.pio/libdeps/',
    '/site-packages/',
    '/.mypy_cache/',
    '/tmp/',
    '/var/tmp/',
  ]

  for (const segment of noisySegments) {
    if (normalizedPath.includes(segment)) {
      score -= resultType === 'repo' ? 60 : 45
    }
  }

  if (normalizedPath.includes('/downloads/')) {
    score += 5
  }

  if (normalizedPath.includes('/pictures/')) {
    score += 5
  }

  if (normalizedPath.includes('/projects/') || normalizedPath.includes('/work/') || normalizedPath.includes('/src/')) {
    score += 12
  }

  const depthPenalty = Math.max(0, normalizedPath.split('/').filter(Boolean).length - 6)
  score -= Math.min(depthPenalty * 2, 20)

  return score
}

function mergeMatchReasons(primary: string, secondary: string): string {
  if (primary.includes(secondary)) return primary
  return `${primary}; ${secondary}`
}

function findFuzzyFileRows(db: Database.Database, normalizedQuery: string): Row[] {
  if (normalizedQuery.length < 4) return []

  return db.prepare(
    `
    SELECT id, path, name, extension, mime_type, metadata_json, modified_at
    FROM file_records
    ORDER BY modified_at DESC
    LIMIT 5000
    `,
  ).all() as Row[]
}

function findFuzzyRepoRows(db: Database.Database, normalizedQuery: string): RepoRow[] {
  if (normalizedQuery.length < 4) return []

  return db.prepare(
    `
    SELECT id, root_path, repo_name, last_commit_at, remote_url
    FROM repo_records
    ORDER BY last_commit_at DESC
    LIMIT 1000
    `,
  ).all() as RepoRow[]
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '')
}

function fuzzySimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeSeparators(left.toLowerCase())
  const normalizedRight = normalizeSeparators(right.toLowerCase())
  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length)
  if (maxLength === 0) return 0
  const distance = levenshteinDistance(normalizedLeft, normalizedRight)
  return 1 - distance / maxLength
}

function levenshteinDistance(left: string, right: string): number {
  const prev = new Array<number>(right.length + 1).fill(0)
  const curr = new Array<number>(right.length + 1).fill(0)

  for (let j = 0; j <= right.length; j += 1) {
    prev[j] = j
  }

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + substitutionCost,
      )
    }

    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = curr[j]
    }
  }

  return prev[right.length] ?? 0
}
