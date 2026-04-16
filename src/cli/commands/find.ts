import { openDatabase } from '../../index/db.js'
import { formatSearchResults } from '../../output/formatResult.js'
import { findMatches } from '../../search/find.js'

export function runFind(query: string): void {
  const db = openDatabase()
  const results = findMatches(db, query)
  db.close()
  console.log(formatSearchResults(results))
}

