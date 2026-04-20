import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { openDatabase } from '../../../src/index/db.js'
import { createHandlers, type Handlers } from '../../../src/daemon/handlers.js'
import { findMatches } from '../../../src/search/find.js'
import type Database from 'better-sqlite3'

function tempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-handlers-'))
  const dbPath = path.join(dir, 'test.sqlite')
  const db = openDatabase(dbPath)
  return {
    db,
    cleanup: () => {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function seedFile(db: Database.Database, id: string, name: string, modifiedAt: string): void {
  db.prepare(
    `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(id, `/tmp/${name}`, name, name.split('.').pop() ?? '', 'text/plain', modifiedAt, '/tmp')
}

describe('daemon handlers', () => {
  let ctx: ReturnType<typeof tempDb>
  let handlers: Handlers
  beforeEach(() => {
    ctx = tempDb()
    handlers = createHandlers({ db: ctx.db, startedAt: Date.now() - 1000 })
    seedFile(ctx.db, 'f1', 'thesis-intro.md', '2026-04-18T10:00:00Z')
    seedFile(ctx.db, 'f2', 'unrelated.txt', '2026-04-19T10:00:00Z')
  })
  afterEach(() => ctx.cleanup())

  it('mm_find returns the same shape as findMatches direct', () => {
    const direct = findMatches(ctx.db, 'thesis')
    const viaHandler = handlers.mm_find({ query: 'thesis' })
    expect(viaHandler).toEqual(direct)
  })

  it('mm_get returns file record with text blobs', () => {
    const result = handlers.mm_get({ id: 'f1' })
    expect(result).toEqual({
      kind: 'file',
      record: expect.objectContaining({ id: 'f1', name: 'thesis-intro.md' }),
      blobs: [],
    })
  })

  it('mm_get returns null when id is unknown', () => {
    expect(handlers.mm_get({ id: 'nope' })).toBeNull()
  })

  it('mm_recent returns files in modified_at desc order', () => {
    const recent = handlers.mm_recent({ limit: 5 })
    expect(recent.map(r => r.resultId)).toEqual(['f2', 'f1'])
  })

  it('mm_recent honors since filter', () => {
    const recent = handlers.mm_recent({ since: '2026-04-19T00:00:00Z' })
    expect(recent.map(r => r.resultId)).toEqual(['f2'])
  })

  it('_ping returns ok with pid and uptime', () => {
    const ping = handlers._ping()
    expect(ping.ok).toBe(true)
    expect(ping.pid).toBe(process.pid)
    expect(ping.uptime_ms).toBeGreaterThanOrEqual(1000)
  })
})
