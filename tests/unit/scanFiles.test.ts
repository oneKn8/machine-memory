import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  extractImageMetadata: vi.fn(),
  extractImageOcr: vi.fn(),
  extractTextFromFileResult: vi.fn(),
}))

vi.mock('../../src/extractors/textExtractor.js', () => ({
  extractTextFromFileResult: mockState.extractTextFromFileResult,
}))

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

describe('scanFiles OCR modes', () => {
  let tempRoot: string
  let tempDbRoot: string
  let dbPath: string
  let screenshotPath: string
  let photoPath: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-files-'))
    tempDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-files-db-'))
    dbPath = path.join(tempDbRoot, 'memory.sqlite')
    screenshotPath = path.join(tempRoot, 'screenshots', 'ui-login.png')
    photoPath = path.join(tempRoot, 'photos', 'colorado-trip.png')

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    fs.mkdirSync(path.dirname(photoPath), { recursive: true })
    fs.writeFileSync(screenshotPath, 'screenshot-bytes')
    fs.writeFileSync(photoPath, 'photo-bytes')

    mockState.extractTextFromFileResult.mockReturnValue({
      success: false,
      content: null,
      extractorType: null,
      reason: 'not text',
    })
    mockState.extractImageMetadata.mockImplementation((filePath: string) => {
      const isScreenshot = filePath === screenshotPath
      return {
        mimeType: 'image/png',
        isImage: true,
        isScreenshot,
        raw: {
          fileCategory: 'image',
          isScreenshot,
          city: isScreenshot ? 'Boulder' : 'Austin',
          state: isScreenshot ? 'Colorado' : 'Texas',
        },
        summaryText: isScreenshot
          ? 'image: ui-login.png\ncategory: screenshot\nlocation: Boulder, Colorado'
          : 'image: colorado-trip.png\ncategory: image\nlocation: Austin, Texas',
      }
    })
    mockState.extractImageOcr.mockImplementation((filePath: string) => ({
      success: true,
      content: filePath === screenshotPath
        ? 'Login dialog with Colorado trip notes'
        : 'Colorado trip photo at the lake',
      extractorType: filePath === screenshotPath ? 'screenshot_ocr' : 'image_ocr',
    }))
  })

  afterEach(() => {
    mockState.extractImageMetadata.mockReset()
    mockState.extractImageOcr.mockReset()
    mockState.extractTextFromFileResult.mockReset()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.rmSync(tempDbRoot, { recursive: true, force: true })
  })

  it('skips OCR in off mode but still stores image metadata summaries', () => {
    const db = openDatabase(dbPath)

    const count = scanFiles(db, [tempRoot], { ocrMode: 'off' })
    const blobs = db
      .prepare(
        `
        SELECT source_id, extractor_type, content
        FROM text_blobs
        ORDER BY extractor_type ASC, content ASC
        `,
      )
      .all() as Array<{ source_id: string; extractor_type: string; content: string }>
    const fileRows = db
      .prepare(
        `
        SELECT name, metadata_json
        FROM file_records
        ORDER BY name ASC
        `,
      )
      .all() as Array<{ name: string; metadata_json: string }>

    db.close()

    expect(count.indexedFiles).toBe(2)
    expect(mockState.extractImageOcr).not.toHaveBeenCalled()
    expect(blobs).toEqual([
      {
        source_id: expect.any(String),
        extractor_type: 'image_metadata',
        content: 'image: colorado-trip.png\ncategory: image\nlocation: Austin, Texas',
      },
      {
        source_id: expect.any(String),
        extractor_type: 'screenshot_metadata',
        content: 'image: ui-login.png\ncategory: screenshot\nlocation: Boulder, Colorado',
      },
    ])
    expect(fileRows).toHaveLength(2)
    expect(JSON.parse(fileRows[0]?.metadata_json ?? '{}').fileCategory).toBe('image')
    expect(JSON.parse(fileRows[1]?.metadata_json ?? '{}').isScreenshot).toBe(true)
  })

  it('runs OCR only for screenshot-like images in screenshots mode', () => {
    const db = openDatabase(dbPath)

    const count = scanFiles(db, [tempRoot], { ocrMode: 'screenshots' })
    const blobs = db
      .prepare(
        `
        SELECT extractor_type, content
        FROM text_blobs
        ORDER BY extractor_type ASC, content ASC
        `,
      )
      .all() as Array<{ extractor_type: string; content: string }>

    db.close()

    expect(count.indexedFiles).toBe(2)
    expect(mockState.extractImageOcr).toHaveBeenCalledTimes(1)
    expect(mockState.extractImageOcr).toHaveBeenCalledWith(screenshotPath)
    expect(mockState.extractImageOcr).not.toHaveBeenCalledWith(photoPath)
    expect(blobs).toEqual([
      {
        extractor_type: 'image_metadata',
        content: 'image: colorado-trip.png\ncategory: image\nlocation: Austin, Texas',
      },
      {
        extractor_type: 'screenshot_metadata',
        content: 'image: ui-login.png\ncategory: screenshot\nlocation: Boulder, Colorado',
      },
      {
        extractor_type: 'screenshot_ocr',
        content: 'Login dialog with Colorado trip notes',
      },
    ])
  })

  it('reuses unchanged files on a second scan instead of rerunning extraction', () => {
    const db = openDatabase(dbPath)

    const first = scanFiles(db, [tempRoot], { ocrMode: 'screenshots' })
    mockState.extractImageOcr.mockClear()
    mockState.extractImageMetadata.mockClear()
    mockState.extractTextFromFileResult.mockClear()

    const second = scanFiles(db, [tempRoot], { ocrMode: 'screenshots' })
    db.close()

    expect(first.indexedFiles).toBe(2)
    expect(second).toEqual({
      indexedFiles: 0,
      reusedFiles: 2,
      textExtractions: 0,
      metadataExtractions: 0,
      ocrExtractions: 0,
    })
    expect(mockState.extractImageOcr).not.toHaveBeenCalled()
    expect(mockState.extractImageMetadata).not.toHaveBeenCalled()
    expect(mockState.extractTextFromFileResult).not.toHaveBeenCalled()
  })
})
