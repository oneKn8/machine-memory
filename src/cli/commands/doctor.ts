import { execFileSync } from 'node:child_process'
import { getDefaultDatabasePath, getDefaultScanRoots } from '../../config/defaults.js'

export function runDoctor(): void {
  console.log('Machine Memory doctor')
  console.log('')
  console.log(`database: ${getDefaultDatabasePath()}`)
  console.log('default roots:')
  for (const root of getDefaultScanRoots()) {
    console.log(`- ${root}`)
  }
  console.log('')
  console.log(`tesseract: ${hasBinary('tesseract') ? 'found' : 'missing'}`)
  console.log(`git: ${hasBinary('git') ? 'found' : 'missing'}`)
}

function hasBinary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

