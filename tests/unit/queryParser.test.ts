import { describe, expect, it } from 'vitest'
import { parseQuery } from '../../src/search/queryParser.js'

describe('parseQuery', () => {
  it('normalizes query text', () => {
    const parsed = parseQuery('Find the PDF about Quantization')
    expect(parsed.normalizedQuery).toBe('find the pdf about quantization')
  })

  it('extracts source hints', () => {
    const parsed = parseQuery('show me the screenshot from yesterday')
    expect(parsed.sourceHints).toContain('screenshot')
  })

  it('extracts all supported source hints in canonical order', () => {
    const parsed = parseQuery(' Repo IMAGE PDF screenshot download ')

    expect(parsed.normalizedQuery).toBe('repo image pdf screenshot download')
    expect(parsed.sourceHints).toEqual([
      'repo',
      'image',
      'pdf',
      'screenshot',
      'download',
    ])
  })

  it('returns an empty normalized query for whitespace-only input', () => {
    const parsed = parseQuery('   ')

    expect(parsed.normalizedQuery).toBe('')
    expect(parsed.sourceHints).toEqual([])
  })
})
