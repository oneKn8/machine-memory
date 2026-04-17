export type ParsedQuery = {
  rawQuery: string
  normalizedQuery: string
  sourceHints: string[]
}

const SOURCE_HINT_ALIASES: Record<string, string[]> = {
  repo: ['repo', 'repository'],
  image: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic'],
  pdf: ['pdf', 'document', 'documents'],
  screenshot: ['screenshot', 'screenshots', 'screen shot', 'screen shots'],
  download: ['download', 'downloads', 'downloaded'],
}

export function parseQuery(rawQuery: string): ParsedQuery {
  const normalizedQuery = rawQuery.trim().toLowerCase()
  const sourceHints = Object.entries(SOURCE_HINT_ALIASES)
    .filter(([, aliases]) => aliases.some(alias => normalizedQuery.includes(alias)))
    .map(([hint]) => hint)

  return {
    rawQuery,
    normalizedQuery,
    sourceHints,
  }
}
