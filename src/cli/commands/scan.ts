import { getDefaultScanRoots } from '../../config/defaults.js'
import { openDatabase } from '../../index/db.js'
import { scanFiles } from '../../scanner/fileScanner.js'
import { scanRepos } from '../../repos/gitRepoScanner.js'

export function runScan(): void {
  const roots = getDefaultScanRoots()
  const db = openDatabase()

  const repoCount = scanRepos(db, roots)
  const fileCount = scanFiles(db, roots)

  db.close()

  console.log(`Scanned roots:`)
  for (const root of roots) {
    console.log(`- ${root}`)
  }
  console.log('')
  console.log(`Indexed repos: ${repoCount}`)
  console.log(`Indexed files: ${fileCount}`)
}

