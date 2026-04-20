import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageDecoder, type DaemonRequest, type DaemonResponse } from '../../../src/daemon/protocol.js'

describe('NDJSON protocol', () => {
  it('encodes a request as one JSON line ending in newline', () => {
    const req: DaemonRequest = { id: 'abc', method: 'mm_find', params: { query: 'thesis' } }
    const encoded = encodeMessage(req)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(encoded.trim())).toEqual(req)
  })

  it('decodes a single complete message', () => {
    const decoder = new MessageDecoder()
    const messages = decoder.push('{"id":"x","result":[]}\n')
    expect(messages).toEqual<DaemonResponse[]>([{ id: 'x', result: [] }])
  })

  it('buffers partial messages until newline arrives', () => {
    const decoder = new MessageDecoder()
    expect(decoder.push('{"id":"x","resu')).toEqual([])
    expect(decoder.push('lt":[]}\n')).toEqual([{ id: 'x', result: [] }])
  })

  it('decodes multiple messages in one chunk', () => {
    const decoder = new MessageDecoder()
    const messages = decoder.push('{"id":"a","result":1}\n{"id":"b","result":2}\n')
    expect(messages).toEqual([
      { id: 'a', result: 1 },
      { id: 'b', result: 2 },
    ])
  })

  it('throws on malformed JSON, leaving the remaining buffer intact', () => {
    const decoder = new MessageDecoder()
    expect(() => decoder.push('not-json\n')).toThrow(/parse/i)
    // After the throw, a subsequent valid message should still parse:
    expect(decoder.push('{"id":"y","result":true}\n')).toEqual([
      { id: 'y', result: true },
    ])
  })
})
