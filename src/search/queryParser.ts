export type ParsedQuery = {
  rawQuery: string
  normalizedQuery: string
  sourceHints: string[]
}

const SOURCE_HINTS = ['repo', 'image', 'pdf', 'screenshot', 'download']

export function parseQuery(rawQuery: string): ParsedQuery {
  const normalizedQuery = rawQuery.trim().toLowerCase()
  const sourceHints = SOURCE_HINTS.filter(hint => normalizedQuery.includes(hint))

  return {
    rawQuery,
    normalizedQuery,
    sourceHints,
  }
}

