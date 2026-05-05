import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F-009 follow-up #1: extraction must NEVER run while a SQLite write
// transaction is held. With extraction inside the transaction, a 30 s PDF
// extract would block every other writer (including the upcoming watcher's
// incoming events) for 30 s. This test pins the property by:
//   1. Mocking the extractor module so each call records performance.now()
//   2. Wrapping db.transaction(fn) so each callback's [open, close] is recorded
//   3. Asserting no extract timestamp lies inside any transaction window
//
// Negative-control: the failure message MUST quote the actual overlap
// timestamp + window. A "expected 0 got N" message that doesn't quote the
// numbers is a sign the spy did not bind — fix the mock before trusting
// a green run.

const mockState = vi.hoisted(() => ({
  extractTextFromFileResult: vi.fn(),
  extractImageMetadata: vi.fn(),
  extractImageOcr: vi.fn(),
  textTimestamps: [] as number[],
  imageTimestamps: [] as number[],
  ocrTimestamps: [] as number[],
}))

vi.mock('../../src/extractors/textExtractor.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/extractors/textExtractor.js')>()
  return {
    ...actual,
    extractTextFromFileResult: mockState.extractTextFromFileResult,
  }
})

vi.mock('../../src/media/imageMetadata.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/media/imageMetadata.js')>()
  return {
    ...actual,
    extractImageMetadata: mockState.extractImageMetadata,
  }
})

vi.mock('../../src/ocr/imageOcr.js', () => ({
  extractImageOcr: mockState.extractImageOcr,
}))

import { openDatabase } from '../../src/index/db.js'
import { scanFiles } from '../../src/scanner/fileScanner.js'

type TxWindow = { open: number; close: number }

function findOverlap(extractTs: number, windows: TxWindow[]): TxWindow | null {
  for (const w of windows) {
    if (extractTs >= w.open && extractTs <= w.close) return w
  }
  return null
}

describe('scanFiles — extraction never runs inside a SQLite write transaction (F-009)', () => {
  let tempRoot: string
  let tempDbRoot: string
  let dbPath: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tx-iso-'))
    tempDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tx-iso-db-'))
    dbPath = path.join(tempDbRoot, 'memory.sqlite')

    mockState.textTimestamps.length = 0
    mockState.imageTimestamps.length = 0
    mockState.ocrTimestamps.length = 0
    mockState.extractTextFromFileResult.mockReset()
    mockState.extractImageMetadata.mockReset()
    mockState.extractImageOcr.mockReset()

    mockState.extractTextFromFileResult.mockImplementation(() => {
      mockState.textTimestamps.push(performance.now())
      return { success: true, content: 'extracted text', extractorType: 'text' }
    })
    mockState.extractImageMetadata.mockImplementation(() => {
      mockState.imageTimestamps.push(performance.now())
      return null
    })
    mockState.extractImageOcr.mockImplementation(() => {
      mockState.ocrTimestamps.push(performance.now())
      return { success: false }
    })

    // Five plain markdown files exercise the text-extraction path. Image
    // files would also test the image/ocr extractors but markdown alone is
    // enough to prove the property: any single extractor call inside a
    // transaction window fails the test.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tempRoot, `note-${i}.md`), `# Note ${i}\n\nbody`)
    }
  })

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.rmSync(tempDbRoot, { recursive: true, force: true })
  })

  it('records zero extract calls inside any transaction window', () => {
    const db = openDatabase(dbPath)
    const txWindows: TxWindow[] = []

    // Wrap db.transaction so every callback's open/close is recorded. We
    // wrap the binding on the live db instance, not the better-sqlite3
    // prototype — keeps the spy scoped to this test.
    const origTransaction = db.transaction.bind(db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(db as unknown as { transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown }).transaction =
      (fn: (...a: unknown[]) => unknown) => {
        const wrapped = origTransaction((...args: unknown[]) => {
          const open = performance.now()
          try {
            return fn(...args)
          } finally {
            txWindows.push({ open, close: performance.now() })
          }
        })
        return wrapped
      }

    try {
      scanFiles(db, [tempRoot])
    } finally {
      db.close()
    }

    // Sanity: the spies actually bound. If textTimestamps is empty, the
    // mock did not intercept and the parity assertion is meaningless.
    expect(mockState.textTimestamps.length, 'extractTextFromFileResult mock did not record any calls — vi.mock did not bind').toBeGreaterThan(0)
    expect(txWindows.length, 'no db.transaction callbacks ran — wrapper did not bind').toBeGreaterThan(0)

    // The property: for every extract timestamp, no transaction window
    // contains it. On failure, quote the actual numbers so a green-because-
    // the-spy-did-not-bind run is impossible.
    const allExtracts = [
      ...mockState.textTimestamps.map(t => ({ kind: 'text' as const, t })),
      ...mockState.imageTimestamps.map(t => ({ kind: 'image' as const, t })),
      ...mockState.ocrTimestamps.map(t => ({ kind: 'ocr' as const, t })),
    ]
    const overlaps = allExtracts
      .map(e => ({ kind: e.kind, t: e.t, window: findOverlap(e.t, txWindows) }))
      .filter(x => x.window !== null)

    if (overlaps.length > 0) {
      const detail = overlaps
        .map(o => `  ${o.kind}@${o.t.toFixed(3)} inside tx[${o.window!.open.toFixed(3)}, ${o.window!.close.toFixed(3)}]`)
        .join('\n')
      throw new Error(
        `F-009 violated: ${overlaps.length}/${allExtracts.length} extractor calls ran INSIDE a SQLite transaction window:\n${detail}`,
      )
    }
  })
})
