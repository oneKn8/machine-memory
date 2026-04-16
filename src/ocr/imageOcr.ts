import { spawnSync } from 'node:child_process'
import { isImageFile, isScreenshotPath } from '../media/imageMetadata.js'
import { hasBinary } from '../system/binaries.js'

const MAX_OCR_CHARACTERS = 40_000

export type ImageOcrResult = {
  success: boolean
  content: string | null
  extractorType: 'image_ocr' | 'screenshot_ocr' | null
  reason?: string
}

export function extractImageOcr(filePath: string): ImageOcrResult {
  if (!isImageFile(filePath)) {
    return {
      success: false,
      content: null,
      extractorType: null,
      reason: 'Unsupported image file type for OCR',
    }
  }

  if (!hasBinary('tesseract')) {
    return {
      success: false,
      content: null,
      extractorType: null,
      reason: 'tesseract is not available on this machine',
    }
  }

  try {
    const result = spawnSync(
      'tesseract',
      [filePath, 'stdout', '--psm', '11'],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )

    if (result.status !== 0) {
      return {
        success: false,
        content: null,
        extractorType: null,
        reason: `tesseract exited with status ${result.status ?? 'unknown'}`,
      }
    }

    const content = normalizeOcrText(result.stdout)
    if (!content) {
      return {
        success: false,
        content: null,
        extractorType: null,
        reason: 'OCR extracted no searchable text',
      }
    }

    return {
      success: true,
      content,
      extractorType: isScreenshotPath(filePath) ? 'screenshot_ocr' : 'image_ocr',
    }
  } catch (error) {
    return {
      success: false,
      content: null,
      extractorType: null,
      reason: error instanceof Error ? error.message : 'Unknown OCR error',
    }
  }
}

function normalizeOcrText(value: string): string | null {
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return null
  return normalized.slice(0, MAX_OCR_CHARACTERS)
}
