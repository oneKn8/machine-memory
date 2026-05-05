import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_SQL } from '../../../src/index/schema.js'
import { runMigrations, currentSchemaVersion, latestMigrationVersion } from '../../../src/index/migrations.js'

describe('runMigrations', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrations-'))
    dbPath = path.join(dir, 'test.sqlite')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('runs cleanly on a fresh DB and bumps user_version', () => {
    const db = new Database(dbPath)
    db.exec(SCHEMA_SQL)
    expect(currentSchemaVersion(db)).toBe(0)
    runMigrations(db)
    expect(currentSchemaVersion(db)).toBe(latestMigrationVersion())
    db.close()
  })

  it('is idempotent — running twice does not throw', () => {
    const db = new Database(dbPath)
    db.exec(SCHEMA_SQL)
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(currentSchemaVersion(db)).toBe(latestMigrationVersion())
    db.close()
  })

  it('skips already-applied migrations across consecutive opens', () => {
    const db1 = new Database(dbPath)
    db1.exec(SCHEMA_SQL)
    runMigrations(db1)
    db1.close()
    const db2 = new Database(dbPath)
    db2.exec(SCHEMA_SQL)  // CREATE IF NOT EXISTS — no-op
    runMigrations(db2)
    expect(currentSchemaVersion(db2)).toBe(latestMigrationVersion())
    db2.close()
  })

  it('adds inode + device columns to file_records', () => {
    const db = new Database(dbPath)
    db.exec(SCHEMA_SQL)
    runMigrations(db)
    const cols = db.prepare(`PRAGMA table_info(file_records)`).all() as Array<{ name: string }>
    const names = cols.map(c => c.name)
    expect(names).toContain('inode')
    expect(names).toContain('device')
    db.close()
  })

  it('does not throw on a DB that already has the columns (manual ALTER scenario)', () => {
    const db = new Database(dbPath)
    db.exec(SCHEMA_SQL)
    // SCHEMA_SQL after Slice 3 Task 6 already includes inode + device
    // for fresh DBs. Migration's addColumnIfMissing must skip them.
    expect(() => runMigrations(db)).not.toThrow()
    db.close()
  })
})
