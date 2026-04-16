import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hasBinary } from '../system/binaries.js'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
])

const MIME_BY_EXTENSION: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
}

type ExifSummary = {
  createDate?: string
  dateTimeOriginal?: string
  imageWidth?: number
  imageHeight?: number
  make?: string
  model?: string
  city?: string
  state?: string
  country?: string
  gpsLatitude?: number
  gpsLongitude?: number
  gpsPosition?: string
}

export type ImageMetadata = {
  mimeType: string | null
  isImage: boolean
  isScreenshot: boolean
  raw: Record<string, unknown>
  summaryText: string | null
}

export function isImageFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(extension)
}

export function isScreenshotPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase()
  const baseName = path.basename(normalizedPath)

  return (
    normalizedPath.includes('/screenshots/') ||
    normalizedPath.includes('/screenshot/') ||
    baseName.includes('screenshot') ||
    baseName.includes('screen shot') ||
    baseName.startsWith('shot-')
  )
}

export function getImageMimeType(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? null
}

export function extractImageMetadata(filePath: string): ImageMetadata {
  const isImage = isImageFile(filePath)
  const isScreenshot = isScreenshotPath(filePath)
  const mimeType = getImageMimeType(filePath)

  const raw: Record<string, unknown> = {
    fileCategory: isImage ? 'image' : 'file',
    isScreenshot,
  }

  const exif = readExifSummary(filePath)
  if (exif) {
    Object.assign(raw, exif)
  }

  return {
    mimeType,
    isImage,
    isScreenshot,
    raw,
    summaryText: buildImageMetadataSummary(filePath, isScreenshot, exif),
  }
}

function readExifSummary(filePath: string): ExifSummary | null {
  if (!hasBinary('exiftool')) return null

  try {
    const result = spawnSync(
      'exiftool',
      [
        '-json',
        '-DateTimeOriginal',
        '-CreateDate',
        '-ImageWidth',
        '-ImageHeight',
        '-Make',
        '-Model',
        '-City',
        '-State',
        '-Country',
        '-GPSLatitude',
        '-GPSLongitude',
        '-GPSPosition',
        filePath,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )

    if (result.status !== 0 || !result.stdout.trim()) {
      return null
    }

    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    const entry = parsed[0]
    if (!entry) return null

    return {
      createDate: asString(entry.CreateDate),
      dateTimeOriginal: asString(entry.DateTimeOriginal),
      imageWidth: asNumber(entry.ImageWidth),
      imageHeight: asNumber(entry.ImageHeight),
      make: asString(entry.Make),
      model: asString(entry.Model),
      city: asString(entry.City),
      state: asString(entry.State),
      country: asString(entry.Country),
      gpsLatitude: asNumber(entry.GPSLatitude),
      gpsLongitude: asNumber(entry.GPSLongitude),
      gpsPosition: asString(entry.GPSPosition),
    }
  } catch {
    return null
  }
}

function buildImageMetadataSummary(
  filePath: string,
  isScreenshot: boolean,
  exif: ExifSummary | null,
): string | null {
  const parts = [`image: ${path.basename(filePath)}`]

  parts.push(isScreenshot ? 'category: screenshot' : 'category: image')

  if (exif?.dateTimeOriginal) parts.push(`captured: ${exif.dateTimeOriginal}`)
  else if (exif?.createDate) parts.push(`created: ${exif.createDate}`)

  if (exif?.make || exif?.model) {
    parts.push(`camera: ${[exif.make, exif.model].filter(Boolean).join(' ')}`)
  }

  if (exif?.imageWidth || exif?.imageHeight) {
    parts.push(`dimensions: ${exif.imageWidth ?? '?'}x${exif.imageHeight ?? '?'}`)
  }

  const locationParts = [exif?.city, exif?.state, exif?.country].filter(Boolean)
  if (locationParts.length > 0) {
    parts.push(`location: ${locationParts.join(', ')}`)
  } else if (exif?.gpsPosition) {
    parts.push(`gps: ${exif.gpsPosition}`)
  }

  return parts.join('\n')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
