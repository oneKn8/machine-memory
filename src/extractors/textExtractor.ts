import fs from 'node:fs'
import path from 'node:path'

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
      parts.push(`keywords: ${keywords.filter(v => typeof v === 'string').join(', ')}`)
    }

    return parts.length > 0 ? parts.join('\n') : raw
  } catch {
    return raw
  }
}

