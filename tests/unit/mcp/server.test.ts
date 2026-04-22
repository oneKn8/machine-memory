import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../../src/mcp/server.js'
import type { SearchResult } from '../../../src/types.js'

type StubCall = (method: string, params: unknown) => Promise<unknown>

function stubClient(callImpl: StubCall): { call: StubCall } {
  return { call: callImpl }
}

describe('createMcpServer', () => {
  let serverTransport: InMemoryTransport
  let clientTransport: InMemoryTransport
  let client: Client
  beforeEach(async () => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '0.0.0' })
  })
  afterEach(async () => {
    await client.close()
  })

  it('lists three tools: mm_find, mm_get, mm_recent', async () => {
    const daemon = stubClient(async () => [])
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.listTools()
    const names = result.tools.map(t => t.name).sort()
    expect(names).toEqual(['mm_find', 'mm_get', 'mm_recent'])
  })

  it('mm_find returns content with resource_link per result and structuredContent', async () => {
    const fakeResults: SearchResult[] = [
      {
        resultId: 'f1',
        resultType: 'file',
        title: 'thesis-intro.md',
        path: '/home/u/thesis-intro.md',
        whyMatched: 'Matched file name or path text',
        score: 165,
        lastModified: '2026-04-18T10:00:00Z',
      },
    ]
    const daemon = stubClient(async (method, params) => {
      expect(method).toBe('mm_find')
      expect(params).toEqual({ query: 'thesis' })
      return fakeResults
    })
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const res = await client.callTool({ name: 'mm_find', arguments: { query: 'thesis' } })
    const links = (res.content as Array<{ type: string; uri?: string }>).filter(c => c.type === 'resource_link')
    expect(links).toHaveLength(1)
    expect(links[0]!.uri).toBe('file:///home/u/thesis-intro.md')
    expect(res.structuredContent).toMatchObject({
      query: 'thesis',
      results: [expect.objectContaining({ id: 'f1', path: '/home/u/thesis-intro.md', score: 165 })],
    })
  })

  it('mm_get for an unknown id returns a structured null record', async () => {
    const daemon = stubClient(async () => null)
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const res = await client.callTool({ name: 'mm_get', arguments: { id: 'nope' } })
    expect(res.structuredContent).toEqual({ id: 'nope', record: null })
    const text = (res.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')
    expect(text?.text).toMatch(/no record/i)
  })

  it('mm_find surfaces daemon errors via isError', async () => {
    const daemon = stubClient(async () => { throw new Error('daemon call timed out after 5000ms: mm_find') })
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const res = await client.callTool({ name: 'mm_find', arguments: { query: 'x' } })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')
    expect(text?.text).toMatch(/timed out/)
  })

  it('mm_find advertises only the query parameter (no silent filters)', async () => {
    const daemon = stubClient(async () => [])
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    const findTool = tools.tools.find(t => t.name === 'mm_find')!
    const schema = findTool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties ?? {})).toEqual(['query'])
    expect(schema.required).toEqual(['query'])
  })

  it('mm_recent passes through since and limit', async () => {
    let captured: unknown = null
    const daemon = stubClient(async (_method, params) => { captured = params; return [] })
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await client.callTool({ name: 'mm_recent', arguments: { since: '2026-04-19T00:00:00Z', limit: 7 } })
    expect(captured).toEqual({ since: '2026-04-19T00:00:00Z', limit: 7 })
  })

  it('emits properly percent-encoded file:// URIs for paths with special chars', async () => {
    const tricky: SearchResult[] = [
      {
        resultId: 'sp1',
        resultType: 'file',
        title: 'My File #1.md',
        path: '/tmp/My File #1.md',
        whyMatched: 'name match',
        score: 100,
        lastModified: '2026-04-21T10:00:00Z',
      },
    ]
    const daemon = stubClient(async () => tricky)
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const findRes = await client.callTool({ name: 'mm_find', arguments: { query: 'tricky' } })
    const findLinks = (findRes.content as Array<{ type: string; uri?: string }>)
      .filter(c => c.type === 'resource_link')
    expect(findLinks).toHaveLength(1)
    expect(findLinks[0]!.uri).toBe('file:///tmp/My%20File%20%231.md')

    const recentRes = await client.callTool({ name: 'mm_recent', arguments: {} })
    const recentLinks = (recentRes.content as Array<{ type: string; uri?: string }>)
      .filter(c => c.type === 'resource_link')
    expect(recentLinks).toHaveLength(1)
    expect(recentLinks[0]!.uri).toBe('file:///tmp/My%20File%20%231.md')
  })
})
