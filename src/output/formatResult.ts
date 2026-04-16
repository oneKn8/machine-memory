import type { SearchResult } from '../types.js'

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No matches found.'
  }

  return results
    .map((result, index) => {
      const lines = [
        `${index + 1}. ${result.title}`,
        `   type: ${result.resultType}`,
        `   path: ${result.path}`,
        `   why: ${result.whyMatched}`,
      ]

      if (result.lastModified) {
        lines.push(`   modified: ${result.lastModified}`)
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

