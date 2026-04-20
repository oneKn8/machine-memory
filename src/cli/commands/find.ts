import { call, isDaemonReachable } from '../../daemon/client.js'
import { getDaemonSocketPath } from '../../daemon/paths.js'
import { openDatabase } from '../../index/db.js'
import { formatSearchResults } from '../../output/formatResult.js'
import { findMatches } from '../../search/find.js'
import type { SearchResult } from '../../types.js'

export async function runFind(query: string): Promise<void> {
  const socketPath = getDaemonSocketPath()
  if (await isDaemonReachable(socketPath)) {
    const results = await call<SearchResult[]>(socketPath, 'mm_find', { query })
    console.log(formatSearchResults(results))
    return
  }
  const db = openDatabase()
  const results = findMatches(db, query)
  db.close()
  console.log(formatSearchResults(results))
}
