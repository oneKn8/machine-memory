import type Database from 'better-sqlite3'

// Slice 3 Task 6 — first real migration the project owns.
//
// Pre-Slice 3, schema.ts was idempotent CREATE TABLE IF NOT EXISTS only;
// the schema never changed after first install. Slice 3 adds inode +
// device columns to file_records to power inode-paired rename detection
// (Task 6 / closes F-011), so we need a real migration mechanism.
//
// PRAGMA user_version is SQLite's built-in schema version counter
// (0 by default for a fresh DB; persists across opens). Each migration
// runs only when its `version` is greater than the stored value, then
// bumps user_version to the new max. Idempotent — running the migration
// list twice is a no-op the second time.

type Migration = {
  version: number
  description: string
  up: (db: Database.Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'add inode + device columns to file_records (Slice 3 Task 6 / F-011 rename pairing)',
    up: db => {
      // Both nullable: pre-existing rows get NULL until the next time
      // the watcher or scanner touches their path. Plan called out the
      // NULL-fallback rename behavior as an acceptable known limitation
      // (self-heals on next event for either path).
      addColumnIfMissing(db, 'file_records', 'inode', 'INTEGER')
      addColumnIfMissing(db, 'file_records', 'device', 'INTEGER')
    },
  },
]

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  // SAFETY: table, column, and ddl are interpolated directly into SQL.
  // All values come from the hardcoded MIGRATIONS array — they are
  // never user input. If this helper is ever generalized, validate
  // identifiers (e.g., /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) before
  // interpolating; PRAGMA does not accept bound parameters.
  // PRAGMA table_info returns a row per column. Idempotent guard so
  // running migrations against a partially-migrated DB (e.g., a manual
  // ALTER from a prior debug session) does not throw `duplicate column`.
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some(c => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function runMigrations(db: Database.Database): void {
  const stored = (db.pragma('user_version', { simple: true }) as number) ?? 0
  for (const m of MIGRATIONS) {
    if (m.version <= stored) continue
    // Each migration runs in its own transaction with version bump
    // inside. SQLite DDL is transactional (CREATE/ALTER TABLE both
    // honor BEGIN/ROLLBACK); a partial-migration crash now rolls back
    // every statement of `m.up` AND leaves user_version unchanged, so
    // the next run re-attempts cleanly. Without this, a future
    // migration that ran 2 of 3 ALTERs and then threw would leave the
    // DB in a half-migrated state with the bumped version forever.
    db.exec('BEGIN')
    try {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* already aborted */ }
      throw err
    }
  }
}

// Exported for tests that want to assert about applied versions without
// poking at PRAGMA directly.
export function currentSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0
}

export function latestMigrationVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
}
