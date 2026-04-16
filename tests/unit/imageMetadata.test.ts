import { describe, expect, it } from 'vitest'
import {
  extractImageMetadata,
  getImageMimeType,
  isImageFile,
  isScreenshotPath,
} from '../../src/media/imageMetadata.js'

describe('image metadata helpers', () => {
  it('detects supported image files', () => {
    expect(isImageFile('/tmp/photo.JPG')).toBe(true)
    expect(isImageFile('/tmp/notes.txt')).toBe(false)
  })

  it('detects screenshot-like paths', () => {
    expect(isScreenshotPath('/captures/screenshots/debug-shot.png')).toBe(true)
    expect(isScreenshotPath('/tmp/Screenshot 2026-04-16 at 10.23.11 AM.png')).toBe(true)
    expect(isScreenshotPath('/photos/colorado-trip.jpg')).toBe(false)
  })

  it('returns MIME hints and summary text for images', () => {
    const metadata = extractImageMetadata('/captures/screenshots/debug-shot.png')

    expect(getImageMimeType('/captures/screenshots/debug-shot.png')).toBe('image/png')
    expect(metadata.isImage).toBe(true)
    expect(metadata.isScreenshot).toBe(true)
    expect(metadata.raw.fileCategory).toBe('image')
    expect(metadata.summaryText).toContain('category: screenshot')
  })
})
