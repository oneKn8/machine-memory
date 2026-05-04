import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { openDatabase } from '../../src/index/db.js'
import { getMcpUrlPath } from '../../src/daemon/paths.js'

// F-015: stdio and HTTP transports must return byte-equal structuredContent
// for identical inputs. Without this, an agent that switches transports (or
// runs both in parallel) sees diverging results from the same daemon — a
// silent contract violation that the manual diff in
// docs/25-phase-1-slice-2-validation.md cannot prevent from regressing.

type Json = unknown

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CORPUS = [
  { id: 'f1', path: '/tmp/thesis-intro.md', name: 'thesis-intro.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-18T10:00:00Z' },
  { id: 'f2', path: '/tmp/notes/raptor-paper.md', name: 'raptor-paper.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-19T11:00:00Z' },
  { id: 'f3', path: '/tmp/notes/mortgage-2026.md', name: 'mortgage-2026.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-20T12:00:00Z' },
  { id: 'f4', path: '/tmp/projects/lighthouse.ts', name: 'lighthouse.ts', ext: 'ts', mime: 'text/x-typescript', mtime: '2026-04-21T13:00:00Z' },
  { id: 'f5', path: '/tmp/projects/orbit.py', name: 'orbit.py', ext: 'py', mime: 'text/x-python', mtime: '2026-04-22T14:00:00Z' },
  { id: 'f6', path: '/tmp/scratch/empty.md', name: 'empty.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-23T15:00:00Z' },
  { id: 'f7', path: '/tmp/refs/zebra-quickbrown.md', name: 'zebra-quickbrown.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-24T16:00:00Z' },
] as const

const QUERY_VOCAB = [
  'thesis', 'raptor', 'mortgage', 'lighthouse', 'orbit', 'zebra', 'quickbrown',
  'notes', 'paper', 'intro',
  'doesnotexist', 'xyzzy', 'never-matches-anything-12345',
  'a', 'the', 'and',                           // stop-words; resolver returns []
  'thesis raptor',                             // multi-token
  'lighthouse orbit zebra',                    // multi-token, all match
  '"phrase that does not exist"',              // quoted
  'mortgage 2026',                             // mixed
]

describe('mcp transport parity (stdio vs http) — F-015', () => {
  let dir: string
  let daemon: DaemonServer | null = null
  let stdioClient: Client | null = null
  let httpClient: Client | null = null

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-parity-'))
    process.env.MM_DATA_DIR = dir
    const dbPath = path.join(dir, 'machine-memory.sqlite')
    const db = openDatabase(dbPath)
    const insertFile = db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
    for (const r of CORPUS) {
      insertFile.run(r.id, r.path, r.name, r.ext, r.mime, r.mtime, '/tmp')
    }
    db.close()

    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath,
    })

    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
      // Same hard-fail policy as mcpStdioBridge.test.ts: a clean checkout
      // running `npm test` should not be able to silently skip transport
      // coverage. CI must run `npm run build` first.
      throw new Error(
        `mmd-mcp bridge not built at ${bridgeScript} — run \`npm run build\` before \`npm test\``,
      )
    }
    stdioClient = new Client({ name: 'parity-stdio', version: '0.0.0' })
    await stdioClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bridgeScript],
      env: { ...process.env, MM_DATA_DIR: dir },
    }))

    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    httpClient = new Client({ name: 'parity-http', version: '0.0.0' })
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(url)))
  })

  afterAll(async () => {
    if (stdioClient) await stdioClient.close()
    if (httpClient) await httpClient.close()
    if (daemon) await daemon.close()
    delete process.env.MM_DATA_DIR
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  // Negative-control sanity: prove the two clients are actually independent
  // before asserting they agree. Without this, a bug that returns the SAME
  // cached object from both clients would pass parity tests vacuously.
  it('clients are distinct instances pointed at the same daemon', () => {
    expect(stdioClient).not.toBe(httpClient)
    expect(stdioClient).toBeInstanceOf(Client)
    expect(httpClient).toBeInstanceOf(Client)
  })

  async function callBoth(name: string, args: Record<string, Json>): Promise<{ stdio: Json; http: Json }> {
    const [stdio, http] = await Promise.all([
      stdioClient!.callTool({ name, arguments: args }),
      httpClient!.callTool({ name, arguments: args }),
    ])
    return { stdio: stdio.structuredContent, http: http.structuredContent }
  }

  it('mm_find returns byte-equal structuredContent across 50 generated queries', async () => {
    const rng = mulberry32(0xC0FFEE)
    const queries: string[] = []
    for (let i = 0; i < 50; i++) {
      // Mix vocab words with random short strings so we cover both "matches
      // a known row" and "matches nothing"; both paths must be parity-stable.
      const useVocab = rng() < 0.7
      if (useVocab) {
        queries.push(QUERY_VOCAB[Math.floor(rng() * QUERY_VOCAB.length)])
      } else {
        const len = 2 + Math.floor(rng() * 10)
        let s = ''
        for (let j = 0; j < len; j++) {
          s += String.fromCharCode(97 + Math.floor(rng() * 26))
        }
        queries.push(s)
      }
    }

    for (const query of queries) {
      const { stdio, http } = await callBoth('mm_find', { query })
      expect(stdio).toEqual(http)
    }
  })

  it('mm_get returns byte-equal structuredContent for every corpus id and one missing id', async () => {
    const ids = [...CORPUS.map(r => r.id), 'this-id-does-not-exist']
    for (const id of ids) {
      const { stdio, http } = await callBoth('mm_get', { id })
      expect(stdio).toEqual(http)
    }
  })

  it('mm_recent returns byte-equal structuredContent across varied since/limit shapes', async () => {
    const shapes: Array<Record<string, Json>> = [
      {},                                                         // defaults
      { limit: 1 },                                               // smallest
      { limit: 100 },                                             // largest
      { since: '2026-04-21T00:00:00Z' },                          // mid-corpus
      { since: '2026-04-21T00:00:00Z', limit: 3 },                // both
      { since: '1970-01-01T00:00:00Z', limit: 100 },              // all
      { since: '2099-01-01T00:00:00Z' },                          // none
    ]
    for (const args of shapes) {
      const { stdio, http } = await callBoth('mm_recent', args)
      expect(stdio).toEqual(http)
    }
  })

  it('listTools returns byte-equal output across transports', async () => {
    const [stdio, http] = await Promise.all([
      stdioClient!.listTools(),
      httpClient!.listTools(),
    ])
    expect(stdio).toEqual(http)
  })
})
