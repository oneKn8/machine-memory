import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/index/db.js'
import { upsertTextBlob } from '../../src/index/textBlobs.js'
import { findMatches } from '../../src/search/find.js'

const mockState = vi.hoisted(() => ({
  tempHome: '',
}))

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => mockState.tempHome || actual.homedir()

  return {
    ...actual,
    default: {
      ...actual,
      homedir,
    },
    homedir,
  }
})

describe('findMatches', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-find-'))
    mockState.tempHome = tempHome
  })

  afterEach(() => {
    mockState.tempHome = ''
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('boosts screenshot-like files when the query asks for screenshots', () => {
    const db = openDatabase()
    db.prepare(
      `
      INSERT INTO file_records (
        id, path, name, extension, mime_type, modified_at, source_root, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'shot-1',
      '/captures/screenshots/debug-shot.png',
      'debug-shot.png',
      'png',
      'image/png',
      '2026-04-16T01:00:00.000Z',
      '/captures',
      JSON.stringify({ fileCategory: 'image', isScreenshot: true }),
    )

    db.prepare(
      `
      INSERT INTO file_records (
        id, path, name, extension, mime_type, modified_at, source_root, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'img-1',
      '/captures/photos/debug-reference.png',
      'debug-reference.png',
      'png',
      'image/png',
      '2026-04-16T01:00:00.000Z',
      '/captures',
      JSON.stringify({ fileCategory: 'image', isScreenshot: false }),
    )

    const results = findMatches(db, 'debug screenshot')
    db.close()

    expect(results[0]?.resultId).toBe('shot-1')
    expect(results[0]?.whyMatched).toBe('Matched screenshot file name or path')
  })

  it('surfaces OCR-backed file matches through indexed text', () => {
    const db = openDatabase()
    db.prepare(
      `
      INSERT INTO file_records (
        id, path, name, extension, mime_type, modified_at, source_root, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'shot-ocr',
      '/captures/screenshots/billing-error.png',
      'billing-error.png',
      'png',
      'image/png',
      '2026-04-16T01:00:00.000Z',
      '/captures',
      JSON.stringify({ fileCategory: 'image', isScreenshot: true }),
    )

    upsertTextBlob(db, {
      sourceId: 'shot-ocr',
      sourceType: 'file',
      extractorType: 'screenshot_ocr',
      content: 'Stripe billing portal configuration error on checkout',
    })

    const results = findMatches(db, 'billing portal screenshot')
    db.close()

    expect(results[0]?.resultId).toBe('shot-ocr')
    expect(results[0]?.whyMatched).toContain('screenshot OCR text')
  })
})
