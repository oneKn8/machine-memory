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
})

