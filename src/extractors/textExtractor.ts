import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
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
])

const MAX_TEXT_BYTES = 256 * 1024

export function extractTextFromFile(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()

  if (ext === '.pdf') {
    return extractTextFromPdf(filePath)
  }

  if (!TEXT_EXTENSIONS.has(ext) && !isSpecialTextFile(base)) {
    return null
  }

  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_TEXT_BYTES) {
      return null
    }

    const content = fs.readFileSync(filePath, 'utf8')
    if (!content.trim()) {
      return null
    }

    if (base === 'package.json') {
      return summarizePackageJson(content)
    }

    return content
  } catch {
    return null
  }
}

function extractTextFromPdf(filePath: string): string | null {
  const pdftotext = findBinary('pdftotext')
  if (!pdftotext) {
    return null
  }

  const outputPath = path.join(
    os.tmpdir(),
    `machine-memory-${process.pid}-${Date.now()}.txt`,
  )

  try {
    execFileSync(pdftotext, [filePath, outputPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const content = fs.readFileSync(outputPath, 'utf8')
    return content.trim() ? content : null
  } catch {
    return null
  } finally {
    try {
      fs.unlinkSync(outputPath)
    } catch {
      // ignore cleanup failures
    }
  }
}

function isSpecialTextFile(base: string): boolean {
  return (
    base === 'readme' ||
    base.startsWith('readme.') ||
    base === 'license' ||
    base.startsWith('license.') ||
    base === 'package.json'
  )
}

function summarizePackageJson(raw: string): string {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>
    const parts: string[] = []

    for (const key of ['name', 'description', 'version']) {
      const value = pkg[key]
      if (typeof value === 'string' && value.trim()) {
        parts.push(`${key}: ${value}`)
      }
    }

    const keywords = pkg.keywords
    if (Array.isArray(keywords) && keywords.length > 0) {
      parts.push(
        `keywords: ${keywords.filter(v => typeof v === 'string').join(', ')}`,
      )
    }

    return parts.length > 0 ? parts.join('\n') : raw
  } catch {
    return raw
  }
}

function findBinary(name: string): string | null {
  try {
    return execFileSync('which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}
