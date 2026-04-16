export type SourceType = 'file' | 'repo' | 'directory'

export type SearchResult = {
  resultId: string
  resultType: SourceType
  title: string
  path: string
  whyMatched: string
  score: number
  lastModified?: string
}

