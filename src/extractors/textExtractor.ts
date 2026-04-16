import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown'])

const PLAIN_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.text',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.zsh',
  '.bash',
  '.sql',
  '.ps1',
])

const PACKAGE_MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.json',
  'composer.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'pipfile',
  'pipfile.lock',
  'requirements.txt',
  'gemfile',
  'gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'deno.json',
  'deno.jsonc',
])

const SPECIAL_PLAIN_TEXT_FILES = new Set([
  'license',
  'copying',
  'notice',
  'changelog',
  'makefile',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
])

const JSON_MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'composer.json',
  'composer.lock',
  'deno.json',
  'deno.jsonc',
  'pipfile.lock',
])

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_CHARACTERS = 200_000
const PDF_COMMAND_BUFFER_BYTES = 10 * 1024 * 1024

const PDF_COMMANDS = [
  {
    command: 'pdftotext',
    args: (filePath: string) => ['-layout', '-nopgbrk', '-q', filePath, '-'],
    strategy: 'pdftotext',
  },
  {
    command: 'mutool',
    args: (filePath: string) => ['draw', '-F', 'txt', '-o', '-', filePath],
    strategy: 'mutool',
  },
] as const

const MANIFEST_STRING_FIELDS = ['name', 'description', 'version', 'packageManager', 'type']
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

export type TextExtractorKind =
  | 'plain_text'
  | 'markdown'
  | 'readme'
  | 'package_manifest'
  | 'pdf'
  | 'unsupported'

export type PdfExtractionStrategy = 'pdftotext' | 'mutool' | 'raw_strings' | 'none'

export type TextExtractionOptions = {
  maxBytes?: number
  maxCharacters?: number
  enableExternalPdfTools?: boolean
}

export type TextExtractionResult = {
  filePath: string
  kind: TextExtractorKind
  extractorType: string | null
  success: boolean
  content: string | null
  warnings: string[]
  reason?: string
  metadata: {
    encoding?: string
    truncated: boolean
    title?: string
    pageCount?: number
    pdfStrategy?: PdfExtractionStrategy
  }
}

export function detectTextExtractorKind(filePath: string): TextExtractorKind {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()

  if (ext === '.pdf') return 'pdf'
  if (PACKAGE_MANIFEST_FILES.has(base)) return 'package_manifest'
  if (isReadmeFile(base)) return 'readme'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (PLAIN_TEXT_EXTENSIONS.has(ext) || SPECIAL_PLAIN_TEXT_FILES.has(base)) {
    return 'plain_text'
  }

  return 'unsupported'
}

export function extractTextFromFile(
  filePath: string,
  options: TextExtractionOptions = {},
): string | null {
  const result = extractTextFromFileResult(filePath, options)
  return result.success ? result.content : null
}

export function extractTextFromFileResult(
  filePath: string,
  options: TextExtractionOptions = {},
): TextExtractionResult {
  const kind = detectTextExtractorKind(filePath)

  if (kind === 'unsupported') {
    return failureResult(filePath, kind, null, 'Unsupported file type for text extraction')
  }

  if (kind === 'pdf') {
    return extractPdfText(filePath, options)
  }

  return extractTextDocument(filePath, kind, options)
}

function extractTextDocument(
  filePath: string,
  kind: Exclude<TextExtractorKind, 'pdf' | 'unsupported'>,
  options: TextExtractionOptions,
): TextExtractionResult {
  const warnings: string[] = []

  try {
    const readResult = readFileBuffer(filePath, normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES))
    const decoded = decodeTextBuffer(readResult.buffer)

    if (!isProbablyTextBuffer(readResult.buffer)) {
      return failureResult(
        filePath,
        kind,
        extractorTypeForKind(kind),
        'File appears to be binary or not safely decodable as text',
        warnings,
        { encoding: decoded.encoding, truncated: readResult.truncated },
      )
    }

    let content = normalizeMultilineText(decoded.text)
    if (!content.trim()) {
      return failureResult(
        filePath,
        kind,
        extractorTypeForKind(kind),
        'Extracted text was empty',
        warnings,
        { encoding: decoded.encoding, truncated: readResult.truncated },
      )
    }

    if (kind === 'package_manifest') {
      content = buildManifestText(filePath, content)
    }

    const limited = limitContent(content, normalizeLimit(options.maxCharacters, DEFAULT_MAX_CHARACTERS))

    if (readResult.truncated) {
      warnings.push(`Read only the first ${readResult.buffer.length} bytes from the file`)
    }

    if (limited.truncated) {
      warnings.push(`Trimmed extracted text to ${normalizeLimit(options.maxCharacters, DEFAULT_MAX_CHARACTERS)} characters`)
    }

    return {
      filePath,
      kind,
      extractorType: extractorTypeForKind(kind),
      success: true,
      content: limited.content,
      warnings,
      metadata: {
        encoding: decoded.encoding,
        truncated: readResult.truncated || limited.truncated,
      },
    }
  } catch (error) {
    return failureResult(
      filePath,
      kind,
      extractorTypeForKind(kind),
      formatErrorMessage(error),
      warnings,
      { truncated: false },
    )
  }
}

function extractPdfText(
  filePath: string,
  options: TextExtractionOptions,
): TextExtractionResult {
  const warnings: string[] = []

  try {
    const readResult = readFileBuffer(filePath, normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES))
    const metadata = extractPdfMetadata(readResult.buffer)
    const maxCharacters = normalizeLimit(options.maxCharacters, DEFAULT_MAX_CHARACTERS)
    const baseMetadata = {
      truncated: readResult.truncated,
      title: metadata.title,
      pageCount: metadata.pageCount,
    }

    if (options.enableExternalPdfTools !== false) {
      let hadExternalTool = false

      for (const candidate of PDF_COMMANDS) {
        const result = runPdfCommand(filePath, candidate.command, candidate.args(filePath))
        if (result.unavailable) continue

        hadExternalTool = true
        if (!result.content) {
          if (result.warning) warnings.push(result.warning)
          continue
        }

        const limited = limitContent(result.content, maxCharacters)
        if (readResult.truncated) {
          warnings.push(`Read only the first ${readResult.buffer.length} bytes of the PDF for metadata and fallback parsing`)
        }
        if (limited.truncated) {
          warnings.push(`Trimmed extracted PDF text to ${maxCharacters} characters`)
        }

        return {
          filePath,
          kind: 'pdf',
          extractorType: 'application/pdf',
          success: true,
          content: limited.content,
          warnings,
          metadata: {
            ...baseMetadata,
            truncated: readResult.truncated || limited.truncated,
            pdfStrategy: candidate.strategy,
          },
        }
      }

      warnings.push(
        hadExternalTool
          ? 'External PDF text extraction was unavailable or returned no text; using built-in fallback'
          : 'No external PDF text extractor was available; using built-in fallback',
      )
    } else {
      warnings.push('External PDF tools were disabled for this extraction run')
    }

    const fallback = extractPdfTextFallback(readResult.buffer)
    warnings.push(...fallback.warnings)

    const limited = limitContent(fallback.content, maxCharacters)
    if (readResult.truncated) {
      warnings.push(`Read only the first ${readResult.buffer.length} bytes of the PDF for fallback parsing`)
    }
    if (limited.truncated) {
      warnings.push(`Trimmed extracted PDF text to ${maxCharacters} characters`)
    }

    if (!limited.content) {
      return failureResult(
        filePath,
        'pdf',
        'application/pdf',
        'Could not recover readable text from the PDF',
        warnings,
        {
          ...baseMetadata,
          truncated: readResult.truncated,
          pdfStrategy: fallback.strategy,
        },
      )
    }

    return {
      filePath,
      kind: 'pdf',
      extractorType: 'application/pdf',
      success: true,
      content: limited.content,
      warnings,
      metadata: {
        ...baseMetadata,
        truncated: readResult.truncated || limited.truncated,
        pdfStrategy: fallback.strategy,
      },
    }
  } catch (error) {
    return failureResult(
      filePath,
      'pdf',
      'application/pdf',
      formatErrorMessage(error),
      warnings,
      {
        truncated: false,
        pdfStrategy: 'none',
      },
    )
  }
}

function buildManifestText(filePath: string, raw: string): string {
  const base = path.basename(filePath).toLowerCase()
  const header = [`manifest: ${base}`]

  if (!JSON_MANIFEST_FILES.has(base)) {
    return `${header.join('\n')}\n\n${raw}`.trim()
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const summaryLines = [...header]

    for (const field of MANIFEST_STRING_FIELDS) {
      const value = parsed[field]
      if (typeof value === 'string' && value.trim()) {
        summaryLines.push(`${field}: ${value}`)
      }
    }

    const privateFlag = parsed.private
    if (typeof privateFlag === 'boolean') {
      summaryLines.push(`private: ${privateFlag}`)
    }

    const keywords = toStringArray(parsed.keywords)
    if (keywords.length > 0) {
      summaryLines.push(`keywords: ${keywords.join(', ')}`)
    }

    const scripts = objectKeys(parsed.scripts)
    if (scripts.length > 0) {
      summaryLines.push(`scripts: ${scripts.join(', ')}`)
    }

    const workspaces = extractWorkspaceEntries(parsed.workspaces)
    if (workspaces.length > 0) {
      summaryLines.push(`workspaces: ${workspaces.join(', ')}`)
    }

    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = objectKeys(parsed[field])
      if (dependencies.length > 0) {
        summaryLines.push(`${field}: ${dependencies.join(', ')}`)
      }
    }

    return `${summaryLines.join('\n')}\n\n${raw}`.trim()
  } catch {
    return `${header.join('\n')}\n\n${raw}`.trim()
  }
}

function readFileBuffer(filePath: string, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  const stat = fs.statSync(filePath)
  const bytesToRead = Math.min(stat.size, maxBytes)

  if (bytesToRead === stat.size) {
    return {
      buffer: fs.readFileSync(filePath),
      truncated: false,
    }
  }

  const fileDescriptor = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, bytesToRead, 0)
    return {
      buffer: buffer.subarray(0, bytesRead),
      truncated: true,
    }
  } finally {
    fs.closeSync(fileDescriptor)
  }
}

function decodeTextBuffer(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: swapUtf16ByteOrder(buffer.subarray(2)).toString('utf16le'), encoding: 'utf-16be' }
  }

  if (looksLikeUtf16Le(buffer)) {
    return { text: buffer.toString('utf16le'), encoding: 'utf-16le' }
  }

  if (looksLikeUtf16Be(buffer)) {
    return { text: swapUtf16ByteOrder(buffer).toString('utf16le'), encoding: 'utf-16be' }
  }

  return { text: buffer.toString('utf8'), encoding: 'utf-8' }
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  if (looksLikeUtf16Le(buffer) || looksLikeUtf16Be(buffer)) return true

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  let nulBytes = 0

  for (const byte of sample) {
    if (byte === 0) nulBytes += 1
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 9)) suspicious += 1
  }

  if (nulBytes > sample.length / 10) return false
  return suspicious / sample.length < 0.3
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  let nulOnOdd = 0
  let pairs = 0

  for (let index = 1; index < Math.min(buffer.length, 200); index += 2) {
    pairs += 1
    if (buffer[index] === 0) nulOnOdd += 1
  }

  return pairs > 0 && nulOnOdd / pairs > 0.6
}

function looksLikeUtf16Be(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  let nulOnEven = 0
  let pairs = 0

  for (let index = 0; index < Math.min(buffer.length, 200); index += 2) {
    pairs += 1
    if (buffer[index] === 0) nulOnEven += 1
  }

  return pairs > 0 && nulOnEven / pairs > 0.6
}

function swapUtf16ByteOrder(buffer: Buffer): Buffer {
  const length = buffer.length - (buffer.length % 2)
  const swapped = Buffer.alloc(length)

  for (let index = 0; index < length; index += 2) {
    swapped[index] = buffer[index + 1]
    swapped[index + 1] = buffer[index]
  }

  return swapped
}

function limitContent(content: string, maxCharacters: number): { content: string; truncated: boolean } {
  if (content.length <= maxCharacters) {
    return {
      content,
      truncated: false,
    }
  }

  const slice = content.slice(0, maxCharacters)
  const newlineIndex = slice.lastIndexOf('\n')
  const limited = newlineIndex > maxCharacters / 2 ? slice.slice(0, newlineIndex) : slice

  return {
    content: limited.trim(),
    truncated: true,
  }
}

function normalizeMultilineText(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
}

function runPdfCommand(
  filePath: string,
  command: string,
  args: string[],
): { content?: string; unavailable: boolean; warning?: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: PDF_COMMAND_BUFFER_BYTES,
  })

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException
    if (error.code === 'ENOENT') {
      return { unavailable: true }
    }

    return {
      unavailable: false,
      warning: `${command} failed: ${error.message}`,
    }
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    return {
      unavailable: false,
      warning: stderr
        ? `${command} exited with ${result.status}: ${stderr}`
        : `${command} exited with ${result.status}`,
    }
  }

  const content = normalizeMultilineText(result.stdout ?? '')
  if (!content) {
    return {
      unavailable: false,
      warning: `${command} returned no readable text`,
    }
  }

  return {
    unavailable: false,
    content,
  }
}

function extractPdfTextFallback(buffer: Buffer): {
  content: string
  strategy: PdfExtractionStrategy
  warnings: string[]
} {
  const warnings: string[] = []
  const document = buffer.toString('latin1')
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/gs
  const lines: string[] = []
  let sawStream = false

  for (const match of document.matchAll(streamPattern)) {
    sawStream = true
    const prefix = document.slice(Math.max(0, (match.index ?? 0) - 200), match.index ?? 0)
    let streamBuffer = Buffer.from(match[1], 'latin1')

    if (/FlateDecode/.test(prefix)) {
      try {
        streamBuffer = zlib.inflateSync(streamBuffer)
      } catch {
        warnings.push('Could not inflate one PDF stream during fallback parsing')
        continue
      }
    }

    const extracted = extractPdfContentStreamText(streamBuffer.toString('latin1'))
    if (extracted) lines.push(extracted)
  }

  if (!sawStream) {
    warnings.push('No PDF streams were found during fallback parsing')
  }

  if (lines.length === 0) {
    const looseText = collectPdfTokens(document)
      .map(token => normalizePdfToken(token))
      .filter(Boolean)
      .join('\n')

    return {
      content: normalizeMultilineText(looseText),
      strategy: lines.length > 0 ? 'raw_strings' : 'raw_strings',
      warnings,
    }
  }

  return {
    content: normalizeMultilineText(dedupeConsecutive(lines).join('\n')),
    strategy: 'raw_strings',
    warnings,
  }
}

function extractPdfContentStreamText(content: string): string {
  const textBlocks = content.match(/BT[\s\S]*?ET/g) ?? []
  const lines = textBlocks
    .map(block => collectPdfTokens(block).map(token => normalizePdfToken(token)).filter(Boolean).join(' '))
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  if (lines.length > 0) {
    return dedupeConsecutive(lines).join('\n')
  }

  return collectPdfTokens(content)
    .map(token => normalizePdfToken(token))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectPdfTokens(source: string): string[] {
  const tokens: string[] = []

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (char === '(') {
      const literal = readPdfLiteralToken(source, index)
      if (!literal) continue

      const decoded = decodePdfLiteralString(literal.token)
      if (decoded) tokens.push(decoded)
      index = literal.endIndex
      continue
    }

    if (char === '<' && source[index + 1] !== '<') {
      const hex = readPdfHexToken(source, index)
      if (!hex) continue

      const decoded = decodePdfHexString(hex.token)
      if (decoded) tokens.push(decoded)
      index = hex.endIndex
    }
  }

  return tokens
}

function readPdfLiteralToken(
  source: string,
  startIndex: number,
): { token: string; endIndex: number } | null {
  let depth = 0
  let escaped = false

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '(') {
      depth += 1
      continue
    }

    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return {
          token: source.slice(startIndex, index + 1),
          endIndex: index,
        }
      }
    }
  }

  return null
}

function readPdfHexToken(
  source: string,
  startIndex: number,
): { token: string; endIndex: number } | null {
  const endIndex = source.indexOf('>', startIndex + 1)
  if (endIndex === -1) return null

  return {
    token: source.slice(startIndex, endIndex + 1),
    endIndex,
  }
}

function decodePdfLiteralString(token: string): string {
  const body = token.slice(1, -1)
  const bytes: number[] = []

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]

    if (char !== '\\') {
      bytes.push(body.charCodeAt(index) & 0xff)
      continue
    }

    const next = body[index + 1]
    if (next == null) break

    index += 1

    switch (next) {
      case 'n':
        bytes.push(0x0a)
        break
      case 'r':
        bytes.push(0x0d)
        break
      case 't':
        bytes.push(0x09)
        break
      case 'b':
        bytes.push(0x08)
        break
      case 'f':
        bytes.push(0x0c)
        break
      case '(':
      case ')':
      case '\\':
        bytes.push(next.charCodeAt(0))
        break
      case '\n':
        break
      case '\r':
        if (body[index + 1] === '\n') index += 1
        break
      default:
        if (/[0-7]/.test(next)) {
          let octal = next

          while (
            index + 1 < body.length &&
            octal.length < 3 &&
            /[0-7]/.test(body[index + 1] ?? '')
          ) {
            octal += body[index + 1]
            index += 1
          }

          bytes.push(Number.parseInt(octal, 8))
        } else {
          bytes.push(next.charCodeAt(0))
        }
    }
  }

  return decodePdfBytes(Buffer.from(bytes))
}

function decodePdfHexString(token: string): string {
  const hex = token.slice(1, -1).replace(/\s+/g, '')
  if (!hex) return ''

  const normalizedHex = hex.length % 2 === 0 ? hex : `${hex}0`
  return decodePdfBytes(Buffer.from(normalizedHex, 'hex'))
}

function decodePdfBytes(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swapUtf16ByteOrder(buffer.subarray(2)).toString('utf16le')
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }

  return buffer.toString('latin1')
}

function extractPdfMetadata(buffer: Buffer): { title?: string; pageCount?: number } {
  const document = buffer.toString('latin1')
  const title = readPdfStringAfterKeyword(document, '/Title')
  const pageCountMatch = document.match(/\/Count\s+(\d+)/)

  return {
    title: title ? normalizePdfToken(title) : undefined,
    pageCount: pageCountMatch ? Number.parseInt(pageCountMatch[1], 10) : undefined,
  }
}

function readPdfStringAfterKeyword(source: string, keyword: string): string | undefined {
  const keywordIndex = source.indexOf(keyword)
  if (keywordIndex === -1) return undefined

  let index = keywordIndex + keyword.length
  while (index < source.length && /\s/.test(source[index] ?? '')) {
    index += 1
  }

  if (source[index] === '(') {
    const token = readPdfLiteralToken(source, index)
    return token ? decodePdfLiteralString(token.token) : undefined
  }

  if (source[index] === '<' && source[index + 1] !== '<') {
    const token = readPdfHexToken(source, index)
    return token ? decodePdfHexString(token.token) : undefined
  }

  return undefined
}

function normalizePdfToken(token: string): string {
  const normalized = token
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''
  if (!/[A-Za-z0-9]/.test(normalized)) return ''
  if (/^(Type|Page|Pages|Font|Catalog|Parent|Kids|Count)$/.test(normalized)) return ''

  return normalized
}

function dedupeConsecutive(values: string[]): string[] {
  return values.filter((value, index) => value !== values[index - 1])
}

function extractorTypeForKind(
  kind: Exclude<TextExtractorKind, 'unsupported'>,
): string {
  switch (kind) {
    case 'markdown':
      return 'text/markdown'
    case 'readme':
      return 'text/readme'
    case 'package_manifest':
      return 'text/package-manifest'
    case 'pdf':
      return 'application/pdf'
    case 'plain_text':
      return 'text/plain'
  }
}

function failureResult(
  filePath: string,
  kind: TextExtractorKind,
  extractorType: string | null,
  reason: string,
  warnings: string[] = [],
  metadata: TextExtractionResult['metadata'] = { truncated: false },
): TextExtractionResult {
  return {
    filePath,
    kind,
    extractorType,
    success: false,
    content: null,
    warnings,
    reason,
    metadata,
  }
}

function isReadmeFile(baseName: string): boolean {
  return baseName === 'readme' || baseName.startsWith('readme.')
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter(key => key.trim().length > 0)
}

function extractWorkspaceEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  }

  if (!value || typeof value !== 'object') return []

  const packagesValue = (value as Record<string, unknown>).packages
  return Array.isArray(packagesValue)
    ? packagesValue.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown extraction error'
}
