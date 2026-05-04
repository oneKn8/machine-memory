import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { openDatabase } from '../../src/index/db.js'
import { upsertTextBlob } from '../../src/index/textBlobs.js'

// F-015: stdio and HTTP transports must return byte-equal CallToolResult
// for identical inputs. Without this, an agent that switches transports (or
// runs both in parallel) sees diverging results from the same daemon — a
// silent contract violation that the manual diff in
// docs/25-phase-1-slice-2-validation.md cannot prevent from regressing.
//
// "Byte-equal" here means canonical JSON: the test serializes both
// responses with sorted keys and compares strings, not just structural
// deep-equality. Structural equality silently passes when one transport
// returns { a: 1 } and the other { a: 1, b: undefined }; canonical-JSON
// equality catches that.

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

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

const CORPUS = [
  { id: 'f1', path: '/tmp/thesis-intro.md', name: 'thesis-intro.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-18T10:00:00Z',
    content: 'Thesis introduction. This document covers raptor migration patterns and orbit modeling.' },
  { id: 'f2', path: '/tmp/notes/raptor-paper.md', name: 'raptor-paper.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-19T11:00:00Z',
    content: 'Raptor paper draft. Discusses lighthouse keepers and zebra crossings.' },
  { id: 'f3', path: '/tmp/notes/mortgage-2026.md', name: 'mortgage-2026.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-20T12:00:00Z',
    content: 'Mortgage notes for 2026. Property at 12 quickbrown lane.' },
  { id: 'f4', path: '/tmp/projects/lighthouse.ts', name: 'lighthouse.ts', ext: 'ts', mime: 'text/x-typescript', mtime: '2026-04-21T13:00:00Z',
    content: 'export function lighthouse() { return "beacon" }' },
  { id: 'f5', path: '/tmp/projects/orbit.py', name: 'orbit.py', ext: 'py', mime: 'text/x-python', mtime: '2026-04-22T14:00:00Z',
    content: 'def orbit(): return "elliptical thesis"' },
  { id: 'f6', path: '/tmp/scratch/empty.md', name: 'empty.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-23T15:00:00Z',
    content: '' },
  { id: 'f7', path: '/tmp/refs/zebra-quickbrown.md', name: 'zebra-quickbrown.md', ext: 'md', mime: 'text/markdown', mtime: '2026-04-24T16:00:00Z',
    content: 'Zebra crossings and quickbrown foxes. References to raptor and orbit.' },
] as const

const REPO = { id: 'r1', root: '/tmp/projects/lighthouse-repo', name: 'lighthouse-repo', mtime: '2026-04-25T09:00:00Z',
  content: 'Lighthouse repo readme. Mentions thesis and orbit and raptor.' }

const QUERY_VOCAB = [
  'thesis', 'raptor', 'mortgage', 'lighthouse', 'orbit', 'zebra', 'quickbrown',
  'notes', 'paper', 'intro',
  'doesnotexist', 'xyzzy', 'never-matches-anything-12345',
  'a', 'the', 'and',
  'thesis raptor',
  'lighthouse orbit zebra',
  'mortgage 2026',
]

// Materialize the generated query set at module scope so refactors of the
// generator don't silently change the test corpus. Determinism check: this
// list is what the test runs against; if you change mulberry32 or the
// generator below, regenerate and commit the new array.
const GENERATED_QUERIES: string[] = (() => {
  const rng = mulberry32(0xC0FFEE)
  const out: string[] = []
  for (let i = 0; i < 50; i++) {
    if (rng() < 0.7) {
      out.push(QUERY_VOCAB[Math.floor(rng() * QUERY_VOCAB.length)])
    } else {
      const len = 2 + Math.floor(rng() * 10)
      let s = ''
      for (let j = 0; j < len; j++) {
        s += String.fromCharCode(97 + Math.floor(rng() * 26))
      }
      out.push(s)
    }
  }
  return Object.freeze(out) as string[]
})()

describe('mcp transport parity (stdio vs http) — F-015', () => {
  let dir: string
  let dbPath: string
  let mcpUrl: string
  let prevDataDir: string | undefined
  let daemon: DaemonServer | null = null
  let stdioClient: Client | null = null
  let httpClient: Client | null = null

  beforeAll(async () => {
    prevDataDir = process.env.MM_DATA_DIR
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-parity-'))
    process.env.MM_DATA_DIR = dir
    dbPath = path.join(dir, 'machine-memory.sqlite')
    const db = openDatabase(dbPath)
    const insertFile = db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
    for (const r of CORPUS) {
      insertFile.run(r.id, r.path, r.name, r.ext, r.mime, r.mtime, '/tmp')
      if (r.content) {
        upsertTextBlob(db, {
          sourceId: r.id,
          sourceType: 'file',
          extractorType: 'text',
          content: r.content,
        })
      }
    }
    db.prepare(
      `INSERT INTO repo_records (id, root_path, repo_name, current_branch, last_commit_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, '{}')`,
    ).run(REPO.id, REPO.root, REPO.name, 'main', REPO.mtime)
    upsertTextBlob(db, {
      sourceId: REPO.id,
      sourceType: 'repo',
      extractorType: 'readme',
      content: REPO.content,
    })
    db.close()

    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath,
    })

    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
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

    // Read the discovery file from THIS daemon's data dir directly rather
    // than via getMcpUrlPath(), which re-reads process.env.MM_DATA_DIR and
    // would race if a concurrent test file mutated the env (vitest's
    // default isolation runs files in separate workers, so this is
    // belt-and-suspenders — but cheap, so wear both).
    mcpUrl = fs.readFileSync(path.join(dir, 'mcp.url'), 'utf8').trim()
    httpClient = new Client({ name: 'parity-http', version: '0.0.0' })
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
  })

  afterAll(async () => {
    if (stdioClient) await stdioClient.close()
    if (httpClient) await httpClient.close()
    if (daemon) await daemon.close()
    if (prevDataDir === undefined) delete process.env.MM_DATA_DIR
    else process.env.MM_DATA_DIR = prevDataDir
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  // Negative-control sanity: prove the two clients are actually independent
  // before asserting they agree. Without this, a bug that returned the SAME
  // cached object from both clients would pass parity tests vacuously.
  it('clients are distinct instances pointed at the same daemon', () => {
    expect(stdioClient).not.toBe(httpClient)
    expect(stdioClient).toBeInstanceOf(Client)
    expect(httpClient).toBeInstanceOf(Client)
  })

  // Call SEQUENTIALLY rather than Promise.all. Concurrent reads against
  // the same SQLite/FTS5 table can return rows in different physical
  // order if scores tie (V8's sort is stable but row-arrival order from
  // SQLite is not guaranteed across connections). Sequential removes the
  // race entirely — the test measures response equality, not concurrent
  // safety.
  async function callBoth(name: string, args: Record<string, unknown>): Promise<{ stdio: unknown; http: unknown }> {
    const stdio = await stdioClient!.callTool({ name, arguments: args })
    const http = await httpClient!.callTool({ name, arguments: args })
    return { stdio, http }
  }

  it('mm_find returns byte-equal CallToolResult across 50 generated queries (with positive ground-truth)', async () => {
    let nonEmptyCount = 0
    for (const query of GENERATED_QUERIES) {
      const { stdio, http } = await callBoth('mm_find', { query })
      // Canonical-JSON byte equality, not just structural — catches
      // undefined-vs-missing-key drift between transports.
      expect(canonicalJson(stdio), `query=${JSON.stringify(query)}`).toBe(canonicalJson(http))
      const sc = (stdio as { structuredContent?: { results?: unknown[] } }).structuredContent
      if (sc?.results && sc.results.length > 0) nonEmptyCount++
    }
    // Without this, every query could return [] on both transports and
    // parity would pass vacuously. Threshold of 10 is loose enough to
    // tolerate query-parser changes but tight enough to catch a regression
    // that drops the entire result set.
    expect(nonEmptyCount, 'too few non-empty result sets — corpus or query vocab is undertesting').toBeGreaterThanOrEqual(10)
  })

  it('mm_find returns the expected hit for a pinned query (ground-truth)', async () => {
    const { stdio, http } = await callBoth('mm_find', { query: 'thesis' })
    expect(canonicalJson(stdio)).toBe(canonicalJson(http))
    const ids = ((stdio as { structuredContent: { results: Array<{ id: string }> } })
      .structuredContent.results).map(r => r.id)
    // 'thesis' appears in f1's name + content, f5's content, and the repo's
    // content. At minimum f1 must be present.
    expect(ids).toContain('f1')
  })

  it('mm_get returns byte-equal CallToolResult for every corpus id and one missing id', async () => {
    const ids = [...CORPUS.map(r => r.id), REPO.id, 'this-id-does-not-exist']
    for (const id of ids) {
      const { stdio, http } = await callBoth('mm_get', { id })
      expect(canonicalJson(stdio), `id=${id}`).toBe(canonicalJson(http))
    }
  })

  it('mm_recent returns byte-equal CallToolResult across varied since/limit shapes (with ground-truth pins)', async () => {
    const cases: Array<{ args: Record<string, unknown>; expectLen: number | 'any' }> = [
      { args: {}, expectLen: 'any' },
      { args: { limit: 1 }, expectLen: 1 },
      { args: { limit: 100 }, expectLen: CORPUS.length },        // 7 files (repo not in mm_recent)
      { args: { since: '2026-04-21T00:00:00Z' }, expectLen: 'any' },
      { args: { since: '2026-04-21T00:00:00Z', limit: 3 }, expectLen: 3 },
      { args: { since: '1970-01-01T00:00:00Z', limit: 100 }, expectLen: CORPUS.length },
      { args: { since: '2099-01-01T00:00:00Z' }, expectLen: 0 },
    ]
    for (const { args, expectLen } of cases) {
      const { stdio, http } = await callBoth('mm_recent', args)
      expect(canonicalJson(stdio), `args=${JSON.stringify(args)}`).toBe(canonicalJson(http))
      if (expectLen !== 'any') {
        const sc = (stdio as { structuredContent: { results: unknown[] } }).structuredContent
        expect(sc.results.length, `expected ${expectLen} results for args=${JSON.stringify(args)}`).toBe(expectLen)
      }
    }
  })

  it('error-path responses are byte-equal across transports', async () => {
    // Invalid input: empty query string fails Zod min(1). Both transports
    // route the validation error through the SDK's JSON-RPC error envelope.
    // If the envelopes ever drift, this catches it.
    const invalidEmpty = await Promise.all([
      stdioClient!.callTool({ name: 'mm_find', arguments: { query: '' } }).catch(e => ({ thrown: String(e) })),
      httpClient!.callTool({ name: 'mm_find', arguments: { query: '' } }).catch(e => ({ thrown: String(e) })),
    ])
    expect(canonicalJson(invalidEmpty[0])).toBe(canonicalJson(invalidEmpty[1]))

    // Missing required field: mm_get with no id.
    const missingField = await Promise.all([
      stdioClient!.callTool({ name: 'mm_get', arguments: {} }).catch(e => ({ thrown: String(e) })),
      httpClient!.callTool({ name: 'mm_get', arguments: {} }).catch(e => ({ thrown: String(e) })),
    ])
    expect(canonicalJson(missingField[0])).toBe(canonicalJson(missingField[1]))

    // Unknown tool.
    const unknownTool = await Promise.all([
      stdioClient!.callTool({ name: 'mm_does_not_exist', arguments: {} }).catch(e => ({ thrown: String(e) })),
      httpClient!.callTool({ name: 'mm_does_not_exist', arguments: {} }).catch(e => ({ thrown: String(e) })),
    ])
    expect(canonicalJson(unknownTool[0])).toBe(canonicalJson(unknownTool[1]))
  })

  it('listTools returns byte-equal projected tool list across transports', async () => {
    // Project to the fields F-015 actually cares about (name, description,
    // schemas) — NOT the full SDK envelope, which can carry transport-
    // specific _meta or pagination cursors that have nothing to do with
    // our daemon's contract.
    const project = (r: { tools: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }> }) =>
      r.tools
        .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name))
    const stdio = await stdioClient!.listTools()
    const http = await httpClient!.listTools()
    expect(canonicalJson(project(stdio))).toBe(canonicalJson(project(http)))
  })
})
