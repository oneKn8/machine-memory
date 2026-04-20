import { call, isDaemonReachable } from '../../daemon/client.js'
import { getDaemonSocketPath } from '../../daemon/paths.js'
import { openDatabase } from '../../index/db.js'
import { formatSearchResults } from '../../output/formatResult.js'
import { findMatches } from '../../search/find.js'
import type { SearchResult } from '../../types.js'

export async function runFind(query: string): Promise<void> {
  const socketPath = getDaemonSocketPath()
  if (await isDaemonReachable(socketPath)) {
    try {
      const results = await call<SearchResult[]>(socketPath, 'mm_find', { query })
      console.log(formatSearchResults(results))
      return
    } catch (cause) {
      // Daemon was reachable at probe time but the call itself failed
      // (timeout, crash, broken pipe, malformed response). Surface a
      // one-line warning and fall through to the direct DB path so the
      // user still gets results instead of an unhandled rejection.
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`mmd: ${message}; falling back to direct DB`)
    }
  }
  const db = openDatabase()
  const results = findMatches(db, query)
  db.close()
  console.log(formatSearchResults(results))
}
