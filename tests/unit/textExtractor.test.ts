import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  detectTextExtractorKind,
  expectedTextExtractorType,
  extractTextFromFileResult,
} from '../../src/extractors/textExtractor.js'

describe('detectTextExtractorKind', () => {
  it('identifies DOCX files by extension', () => {
    expect(detectTextExtractorKind('/tmp/example.docx')).toBe('docx')
    expect(detectTextExtractorKind('/tmp/MIXED.DocX')).toBe('docx')
  })

  it('still identifies PDF, markdown, and plain text', () => {
    expect(detectTextExtractorKind('/tmp/paper.pdf')).toBe('pdf')
    expect(detectTextExtractorKind('/tmp/notes.md')).toBe('markdown')
    expect(detectTextExtractorKind('/tmp/config.yaml')).toBe('plain_text')
  })
})

describe('expectedTextExtractorType', () => {
  it('returns the DOCX extractor type for docx files', () => {
    expect(expectedTextExtractorType('/tmp/hw.docx')).toBe('application/docx')
  })

  it('returns null for unsupported extensions', () => {
    expect(expectedTextExtractorType('/tmp/image.png')).toBeNull()
  })
})

describe('DOCX extraction', () => {
  let tempRoot: string
  let docxPath: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-docx-'))

    const contentDir = path.join(tempRoot, 'docx-src')
    const wordDir = path.join(contentDir, 'word')
    fs.mkdirSync(wordDir, { recursive: true })

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Statistical methods for data analysis</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chapter 1: Probability &amp; distributions</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>The mean of a sample</w:t></w:r>
      <w:r><w:tab/></w:r>
      <w:r><w:t>is written x&#772;.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`
    fs.writeFileSync(path.join(wordDir, 'document.xml'), documentXml)

    docxPath = path.join(tempRoot, 'stats-book.docx')
    const result = spawnSync(
      'zip',
      ['-rq', docxPath, 'word'],
      { cwd: contentDir, encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(`zip failed: ${result.stderr}`)
    }
  })

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('extracts readable text from a minimal DOCX', () => {
    const result = extractTextFromFileResult(docxPath)

    expect(result.success).toBe(true)
    expect(result.extractorType).toBe('application/docx')
    expect(result.content).toContain('Statistical methods for data analysis')
    expect(result.content).toContain('Probability & distributions')
    expect(result.content).toContain('The mean of a sample')
  })

  it('preserves paragraph breaks between DOCX paragraphs', () => {
    const result = extractTextFromFileResult(docxPath)

    expect(result.content).toMatch(/data analysis\s*\n\s*\n/)
    expect(result.content).toMatch(/Probability & distributions/)
  })

  it('returns a graceful failure when the DOCX is not a valid zip', () => {
    const brokenPath = path.join(tempRoot, 'broken.docx')
    fs.writeFileSync(brokenPath, 'not-a-real-docx')

    const result = extractTextFromFileResult(brokenPath)

    expect(result.success).toBe(false)
    expect(result.kind).toBe('docx')
    expect(result.extractorType).toBe('application/docx')
    expect(typeof result.reason).toBe('string')
  })
})
