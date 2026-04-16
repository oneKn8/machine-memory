import {
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getDefaultScanRoots,
} from '../../config/defaults.js'
import { loadConfig } from '../../config/loadConfig.js'
import { hasBinary } from '../../system/binaries.js'

export function runDoctor(): void {
  const config = loadConfig()
  const roots = config.roots && config.roots.length > 0
    ? config.roots
    : getDefaultScanRoots()

  console.log('Machine Memory doctor')
  console.log('')
  console.log(`database: ${getDefaultDatabasePath()}`)
  console.log(`config: ${getDefaultConfigPath()}`)
  console.log('scan roots:')
  for (const root of roots) {
    console.log(`- ${root}`)
  }
  console.log('')
  console.log(`tesseract: ${hasBinary('tesseract') ? 'found' : 'missing'}`)
  console.log(`pdftotext: ${hasBinary('pdftotext') ? 'found' : 'missing'}`)
  console.log(`exiftool: ${hasBinary('exiftool') ? 'found' : 'missing (optional)'}`)
  console.log(`git: ${hasBinary('git') ? 'found' : 'missing'}`)
}
