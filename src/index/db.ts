import Database from 'better-sqlite3'
import { resolveDatabasePath } from '../config/paths.js'
import { SCHEMA_SQL } from './schema.js'

export function openDatabase(customPath?: string): Database.Database {
  const dbPath = resolveDatabasePath(customPath)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  return db
}
