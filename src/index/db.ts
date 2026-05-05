import Database from 'better-sqlite3'
import { resolveDatabasePath } from '../config/paths.js'
import { SCHEMA_SQL } from './schema.js'
import { runMigrations } from './migrations.js'

export function openDatabase(customPath?: string): Database.Database {
  const dbPath = resolveDatabasePath(customPath)
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  // F-009 bulk-write tuning. Rationale and citations in
  // docs/22-phase-2-research.md §1. synchronous=NORMAL is
  // corruption-safe on WAL; it only gives up last-uncommitted-
  // transaction durability on power loss, which is acceptable
  // because the index can always be rebuilt from the filesystem.
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000')            // 64 MB page cache
  db.pragma('temp_store = MEMORY')            // temp indices in RAM
  db.pragma('mmap_size = 268435456')          // 256 MB mmap window
  db.pragma('wal_autocheckpoint = 5000')      // fewer checkpoint stalls
  db.pragma('journal_size_limit = 67108864')  // 64 MB WAL cap

  db.exec(SCHEMA_SQL)
  // Migrations after SCHEMA_SQL: SCHEMA_SQL is CREATE IF NOT EXISTS
  // only and never alters; migrations.ts owns column adds and any
  // future schema evolution keyed off PRAGMA user_version.
  runMigrations(db)
  return db
}
