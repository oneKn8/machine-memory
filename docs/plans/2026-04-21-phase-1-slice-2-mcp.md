# Phase 1 Slice 2: Embedded MCP Server (stdio bridge + HTTP)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` discipline for every task: write the failing test first, then the minimal code, then commit. Each task is its own commit on the `phase-1-slice-2` branch (already created). Open the PR at the end of Task 8. Per `feedback_pr_workflow`: this is major work — direct push to `main` is forbidden.

**Goal:** Make the daemon's tools callable from any MCP-speaking AI agent (Claude Desktop, Claude Code, Cursor, etc.) by exposing `mm_find` / `mm_get` / `mm_recent` over real MCP. Two transports ship together: a stdio bridge process for agents that prefer to spawn a child, and an HTTP listener inside the daemon for agents that prefer a URL.

**Architecture:**

The Slice 1 daemon (`mmd`) and its NDJSON Unix-socket protocol stay exactly as they are — that's the internal IPC the human CLI uses. On top of that:

- A new `src/mcp/server.ts` module defines a single `createMcpServer(daemonClient)` factory using `@modelcontextprotocol/sdk@^1.29.0`'s `McpServer` API. Three tools, each handler proxies via the existing `client.call()` to the daemon.
- The same factory's output gets mounted on **two** transports:
  - **Stdio:** a new `bin/mmd-mcp` binary (`src/mcp/stdio.ts`) spawns per-agent-session, connects the McpServer to a `StdioServerTransport`. Probes the daemon socket at startup; exits 1 if unreachable. This is what Claude Desktop / older clients spawn.
  - **HTTP:** mounted inside the daemon process via `StreamableHTTPServerTransport`, bound to `127.0.0.1:0` (OS-picked port). The actual URL is written to `~/.local/share/machine-memory/mcp.url` on startup and removed on shutdown. Slice 4's installer will read that file to register HTTP-preferring agents.

The two transports share zero plumbing beyond `createMcpServer(client)` — they just connect different `Transport` implementations to the same server. Tool definitions live in one place and stay in sync.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk@^1.29.0`, `zod` (peer dep of the SDK; install if not already pulled in), better-sqlite3 (existing), `node:http` (built in, used for the streamable HTTP listener), vitest.

**Reference docs read before writing this plan:**
- `docs/23-product-v2-architecture.md` §4.6 (MCP surface intent)
- `docs/22-phase-2-research.md` §3 (`mm_find` / `mm_get` JSON Schema definitions — verbatim source for our Zod schemas)
- `docs/13-decision-log.md` D-018, D-022 (agents-first; prompt-per-agent registration)
- `docs/plans/2026-04-19-phase-1-slice-1-daemon-skeleton.md` Task 4 + post-merge fix-ups (the daemon shape this slice sits on)
- MCP TS SDK current state via context7: `McpServer`, `server.registerTool(name, config, handler)`, `inputSchema`/`outputSchema` (Zod), `content` array with `resource_link` type, `structuredContent` matching outputSchema.
- `npm view @modelcontextprotocol/sdk version` → `1.29.0` is `latest` as of 2026-04-21. v2 is alpha; do not use.

**Ship bar (slice acceptance):**
- A real MCP client (the SDK's `Client` from `@modelcontextprotocol/sdk/client/index.js`) can:
  - Connect to the spawned `mmd-mcp` bridge via `StdioClientTransport` AND list tools AND call `mm_find` AND get a schema-valid response with at least one `resource_link` entry in `content[]`.
  - Connect to the daemon's HTTP endpoint via `StreamableHTTPClientTransport` (URL read from `~/.local/share/machine-memory/mcp.url`) AND do the same.
- The discovery file is created on daemon startup with a real `http://127.0.0.1:<port>/mcp` URL, removed on shutdown.
- All Slice 1 tests still pass; Slice 1 ship bar (parity of `mm find` direct vs daemon) still holds.
- No regression in `mm daemon start/stop/status`.
- `npm run typecheck` and `npm run build` clean.

**Out of scope (do not creep — name what's deferred):**
- Authentication for HTTP (loopback-only is the v1 trust model; D-024 records this).
- `mm_chat` / `mm_subscribe` MCP tools (Phase 4 / Phase 3 work).
- Auto-registration of MCP servers in agent configs (Slice 4's `npx machine-memory init`).
- Activity-stream-backed `mm_recent` (Phase 2 — Slice 2 keeps `modified_at` as the source).
- Token-based auth on the stdio bridge (stdio is per-process; the daemon socket is 0600).

---

## Task 1: Carry over Slice 1's two final-review tightenings

**Why:** Two non-blocking items deferred from Slice 1's final review (`isDaemonRequest` doesn't validate the id field; `mm_get` has no daemon-boundary test for unknown id). Both matter more now that real MCP clients are about to depend on the contract — an MCP client matches responses by `id` and will silently drop a non-string id. Land these first as the slice's first commit so the rest of the slice builds on a tight foundation.

**Files:**
- Modify: `src/daemon/serverCore.ts` (the `isDaemonRequest` guard)
- Modify: `tests/integration/daemonRoundtrip.test.ts` (one new test for unknown-id `mm_get`)
- Modify: `tests/unit/daemon/protocol.test.ts` OR `tests/integration/daemonRoundtrip.test.ts` (one new test for non-string id rejection — pick whichever boundary is more honest)

**Step 1: Write the failing tests**

Add to `tests/integration/daemonRoundtrip.test.ts`:

```ts
it('mm_get returns null result envelope for unknown id', async () => {
  const res = await rpc(socketPath, 'mm_get', { id: 'definitely-not-a-real-id' })
  expect(res.error).toBeUndefined()
  expect(res.result).toBeNull()
})

it('rejects requests whose id is not a string', async () => {
  // Open a raw connection so we can send malformed framing the typed client refuses
  const malformed = JSON.stringify({ id: 123, method: '_ping', params: {} }) + '\n'
  const res = await rpcRaw(socketPath, malformed)
  expect(res.error).toMatchObject({ code: -32600 })
  expect(res.id).toBeNull()
})
```

If `rpcRaw` doesn't exist in the test file, add it as a small helper:

```ts
function rpcRaw(socketPath: string, line: string): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    const decoder = new MessageDecoder()
    client.setEncoding('utf8')
    client.on('data', chunk => {
      try {
        const messages = decoder.push(chunk as string) as DaemonResponse[]
        if (messages.length > 0) {
          client.end()
          resolve(messages[0]!)
        }
      } catch (err) { reject(err) }
    })
    client.on('error', reject)
    client.on('connect', () => { client.write(line) })
  })
}
```

**Step 2: Run tests, confirm both fail**

Run: `npx vitest run tests/integration/daemonRoundtrip.test.ts`
Expected:
- `mm_get returns null result envelope for unknown id` — **PASSES already** (the handler already returns `null` for unknown id; this test is regression coverage, not a fix). If it fails, investigate before continuing.
- `rejects requests whose id is not a string` — **FAILS** with the `id: 123` reaching dispatch and being echoed back as the response id.

**Step 3: Tighten `isDaemonRequest` in `src/daemon/serverCore.ts`**

Find the existing `isDaemonRequest` function and add the `id` check:

```ts
function isDaemonRequest(message: unknown): message is DaemonRequest {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return (
    typeof m.method === 'string' &&
    typeof m.id === 'string' &&
    m.result === undefined &&
    m.error === undefined
  )
}
```

When the guard rejects, the existing `-32600 invalid request` envelope path already writes `id: null`. No other change needed.

**Step 4: Run tests, confirm both pass**

Run: `npx vitest run tests/integration/daemonRoundtrip.test.ts`
Expected: full file green.

Run: `npx vitest run` — full suite green.
Run: `npm run typecheck` — clean.

**Step 5: Commit**

```bash
git add src/daemon/serverCore.ts tests/integration/daemonRoundtrip.test.ts
git commit -m "fix(daemon): require string id on requests; pin null mm_get contract

Carry-over from Slice 1's final review. Two contract tightenings the
MCP layer in this slice will rely on:

- isDaemonRequest now requires typeof id === 'string'. A request with
  id: 123 used to slip through and the dispatcher echoed the number
  back; an MCP client matching responses by uuid would drop it
  silently. Now the guard fails and the server replies with the
  existing -32600 invalid-request envelope and id: null.

- Adds an integration test pinning mm_get { id: <unknown> } returns a
  null result envelope (not an error envelope), so the MCP tool that
  wraps it next has a stable null contract to map onto."
```

---

## Task 2: Add the MCP SDK dependency

**Why:** Every other task in this slice needs the SDK. Land the dependency first as its own commit so the diff is auditable.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated by npm)

**Step 1: Confirm the version is still right**

Run: `source ~/.nvm/nvm.sh && nvm use default && npm view @modelcontextprotocol/sdk version`
Expected: `1.29.0` (or higher minor — anything `^1.29.0` is fine; do NOT take 2.x; v2 is still alpha as of 2026-04-21).

**Step 2: Install**

```bash
source ~/.nvm/nvm.sh && nvm use default && npm install @modelcontextprotocol/sdk@^1.29.0
```

This will likely also pull `zod` as a transitive peer; check `package-lock.json` afterward. If `zod` is NOT in `dependencies`, add it explicitly at the same major version the SDK uses (check `package-lock.json` for the resolved version; usually `zod@^3.x`):

```bash
npm install zod@<resolved-major>
```

**Step 3: Verify build still works**

Run: `npm run build` — clean.
Run: `npm run typecheck` — clean.
Run: `npx vitest run` — full suite green (no behavior added yet, just dep).

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @modelcontextprotocol/sdk dependency for slice 2

Adds the official TypeScript SDK at v1 (latest stable). Slice 2 uses
McpServer from @modelcontextprotocol/sdk/server/mcp.js for the tool
surface and StdioServerTransport / StreamableHTTPServerTransport for
the two transports the slice ships. v2 is still alpha — revisit when
it stabilizes."
```

---

## Task 3: MCP tool factory `src/mcp/server.ts`

**Why:** Single source of truth for the three MCP tools' schemas and handlers. Both transports (stdio bridge + HTTP) instantiate via this factory so the tool definitions cannot drift.

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/types.ts` (Zod schemas)
- Create: `tests/unit/mcp/server.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/unit/mcp/server.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../../src/mcp/server.js'
import type { SearchResult } from '../../../src/types.js'
import type { LoadedRecord } from '../../../src/index/loadRecord.js'

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
    // Spec: content[] should include one resource_link per file/repo result
    const links = (res.content as Array<{ type: string; uri?: string }>).filter(c => c.type === 'resource_link')
    expect(links).toHaveLength(1)
    expect(links[0]!.uri).toBe('file:///home/u/thesis-intro.md')
    // structuredContent matches outputSchema
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
    // text content describes the miss in human-readable form
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

  it('mm_recent passes through since and limit', async () => {
    let captured: unknown = null
    const daemon = stubClient(async (_method, params) => { captured = params; return [] })
    const server = createMcpServer({ daemon })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await client.callTool({ name: 'mm_recent', arguments: { since: '2026-04-19T00:00:00Z', limit: 7 } })
    expect(captured).toEqual({ since: '2026-04-19T00:00:00Z', limit: 7 })
  })
})
```

**Step 2: Run tests, confirm failure**

Run: `npx vitest run tests/unit/mcp/server.test.ts`
Expected: FAIL — `src/mcp/server.ts` doesn't exist.

(If the SDK doesn't ship `InMemoryTransport`, fall back to a minimal one-test integration via `StdioServerTransport` over a pipe — but check the SDK exports first; v1.29 should have it under `@modelcontextprotocol/sdk/inMemory.js`. If the path is different, query context7 once and use the right one.)

**Step 3: Implement the schemas**

```ts
// src/mcp/types.ts
import { z } from 'zod'

export const FindInputSchema = z.object({
  query: z.string().min(1).describe('Natural language or keyword search query'),
  kinds: z.array(z.enum(['file', 'repo', 'screenshot', 'pdf', 'docx', 'code'])).optional()
    .describe('Filter results to these source kinds'),
  path_prefix: z.string().optional().describe('Restrict to paths under this prefix'),
  since: z.string().optional().describe('ISO 8601 timestamp; only return items modified since'),
  limit: z.number().int().min(1).max(20).default(5).describe('Max results to return'),
})

export const FindResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    id: z.string(),
    kind: z.enum(['file', 'repo', 'directory']),
    path: z.string(),
    title: z.string(),
    score: z.number(),
    last_modified: z.string().optional(),
    why_matched: z.string(),
  })),
})

export const GetInputSchema = z.object({
  id: z.string().describe('Result id from a prior mm_find call'),
})

export const GetResultSchema = z.object({
  id: z.string(),
  record: z.union([
    z.object({
      kind: z.literal('file'),
      record: z.record(z.string(), z.unknown()),
      blobs: z.array(z.object({ extractor_type: z.string(), snippet: z.string() })),
    }),
    z.object({
      kind: z.literal('repo'),
      record: z.record(z.string(), z.unknown()),
      blobs: z.array(z.object({ extractor_type: z.string(), snippet: z.string() })),
    }),
    z.null(),
  ]),
})

export const RecentInputSchema = z.object({
  since: z.string().optional().describe('ISO 8601 timestamp; only events at or after'),
  limit: z.number().int().min(1).max(100).default(20),
})

export const RecentResultSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    last_modified: z.string().optional(),
  })),
})
```

**Step 4: Implement the factory**

```ts
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SearchResult } from '../types.js'
import type { LoadedRecord } from '../index/loadRecord.js'
import {
  FindInputSchema, FindResultSchema,
  GetInputSchema, GetResultSchema,
  RecentInputSchema, RecentResultSchema,
} from './types.js'

export type DaemonClient = {
  call: <R = unknown>(method: string, params: unknown) => Promise<R>
}

export type CreateMcpServerOptions = {
  daemon: DaemonClient
  serverName?: string
  serverVersion?: string
}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: opts.serverName ?? 'machine-memory', version: opts.serverVersion ?? '0.1.0' },
    {
      instructions:
        'Use mm_find before running grep/ls/find on the user\'s machine. Each result includes a resource_link you can resolve. Call mm_get for the full record (including text snippets) when you need to read deeper.',
    },
  )

  server.registerTool(
    'mm_find',
    {
      title: 'Search the local machine memory',
      description:
        'Search the local machine\'s indexed memory (files, repos, PDFs, screenshots, code). Returns ranked results with provenance and resource_link entries you can fetch.',
      inputSchema: FindInputSchema.shape,
      outputSchema: FindResultSchema.shape,
    },
    async ({ query }) => {
      try {
        const results = await opts.daemon.call<SearchResult[]>('mm_find', { query })
        const structured = {
          query,
          results: results.map(r => ({
            id: r.resultId,
            kind: r.resultType,
            path: r.path,
            title: r.title,
            score: r.score,
            last_modified: r.lastModified,
            why_matched: r.whyMatched,
          })),
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(structured, null, 2) },
            ...results.map(r => ({
              type: 'resource_link' as const,
              uri: `file://${r.path}`,
              name: r.title,
            })),
          ],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_find failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'mm_get',
    {
      title: 'Fetch a single indexed record',
      description: 'Fetch one indexed record by id. Returns the full file/repo metadata and any extracted text blob snippets.',
      inputSchema: GetInputSchema.shape,
      outputSchema: GetResultSchema.shape,
    },
    async ({ id }) => {
      try {
        const record = await opts.daemon.call<LoadedRecord>('mm_get', { id })
        const structured = { id, record }
        return {
          content: record === null
            ? [{ type: 'text' as const, text: `no record found for id ${id}` }]
            : [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_get failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'mm_recent',
    {
      title: 'List recently modified files',
      description: 'Return recently modified files from the index, optionally filtered by since timestamp. Slice 2 backs this with file_records.modified_at; Phase 2 will switch to the activity event stream.',
      inputSchema: RecentInputSchema.shape,
      outputSchema: RecentResultSchema.shape,
    },
    async ({ since, limit }) => {
      try {
        const results = await opts.daemon.call<SearchResult[]>('mm_recent', { since, limit })
        const structured = {
          results: results.map(r => ({
            id: r.resultId,
            path: r.path,
            title: r.title,
            last_modified: r.lastModified,
          })),
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(structured, null, 2) },
            ...results.map(r => ({
              type: 'resource_link' as const,
              uri: `file://${r.path}`,
              name: r.title,
            })),
          ],
          structuredContent: structured,
        }
      } catch (cause) {
        return {
          content: [{ type: 'text' as const, text: `mm_recent failed: ${(cause as Error).message}` }],
          isError: true,
        }
      }
    },
  )

  return server
}
```

**Step 5: Run tests, confirm pass**

Run: `npx vitest run tests/unit/mcp/server.test.ts` — expect 5 passing.
Run: `npx vitest run` — full suite green.
Run: `npm run typecheck` — clean.

**Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/types.ts tests/unit/mcp/server.test.ts
git commit -m "feat(mcp): tool factory exposing mm_find/mm_get/mm_recent

createMcpServer({daemon}) builds an McpServer that registers the three
tools backed by the existing daemon NDJSON client. Tool schemas are
Zod, matching the JSON Schema sketches in docs/22-phase-2-research.md
§3. Each find/recent result emits a resource_link content entry so
agents can cite (and optionally fetch) the underlying file without a
follow-up tool call.

Daemon-side errors propagate as isError-true tool responses with the
underlying message in content[]; clients should surface to users.

Both transports landing in the next two tasks (stdio bridge + HTTP)
mount this same factory output. The factory is the single source of
truth for tool definitions across transports."
```

---

## Task 4: Stdio bridge `bin/mmd-mcp`

**Why:** The standard MCP transport for desktop agents (Claude Desktop especially). Spawn-per-session: agent launches `mmd-mcp`, bridge connects to the always-on daemon over its Unix socket, every MCP tool call proxies through.

**Files:**
- Create: `src/mcp/stdio.ts` (the bin entry point)
- Modify: `src/daemon/client.ts` IF its `call()` and `isDaemonReachable()` need to be importable (they already are).
- Create: `tests/integration/mcpStdioBridge.test.ts`

**Step 1: Write the failing integration test**

```ts
// tests/integration/mcpStdioBridge.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { openDatabase } from '../../src/index/db.js'

describe('mmd-mcp stdio bridge', () => {
  let dir: string
  let daemon: DaemonServer | null
  let client: Client | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-stdio-'))
    process.env.MM_DATA_DIR = dir
    // Seed a file row via direct DB so mm_find has something to return.
    const dbPath = path.join(dir, 'machine-memory.sqlite')
    const db = openDatabase(dbPath)
    db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run('f1', '/tmp/thesis-intro.md', 'thesis-intro.md', 'md', 'text/markdown', '2026-04-18T10:00:00Z', '/tmp')
    db.close()
    // Bring daemon up.
    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath,
    })
    client = null
  })

  afterEach(async () => {
    if (client) await client.close()
    if (daemon) await daemon.close()
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lists tools and serves mm_find via the bridge over stdio', async () => {
    // Make the bridge spawn from the built dist (assumes npm run build was run)
    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
      // Skip with a clear message rather than fail confusingly
      console.warn('skipping: dist/mcp/stdio.js not present — run npm run build first')
      return
    }
    client = new Client({ name: 'integration-test', version: '0.0.0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bridgeScript],
      env: { ...process.env, MM_DATA_DIR: dir },
    })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual(['mm_find', 'mm_get', 'mm_recent'])

    const res = await client.callTool({ name: 'mm_find', arguments: { query: 'thesis' } })
    expect(res.structuredContent).toMatchObject({
      query: 'thesis',
      results: [expect.objectContaining({ id: 'f1' })],
    })
  })

  it('exits non-zero when the daemon is not reachable', async () => {
    // Tear down the daemon first
    await daemon!.close()
    daemon = null

    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
      console.warn('skipping: dist/mcp/stdio.js not present — run npm run build first')
      return
    }
    // Spawn the bridge directly (not through MCP Client) so we can read its exit code
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [bridgeScript], {
      env: { ...process.env, MM_DATA_DIR: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const exitCode = await new Promise<number>(resolve => {
      child.on('exit', code => resolve(code ?? -1))
    })
    expect(exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/daemon not running/i)
  })
})
```

**Step 2: Run test, confirm failure**

Run: `npx vitest run tests/integration/mcpStdioBridge.test.ts`
Expected: FAIL — module path not built; the test logs the skip but with no source it cannot verify behavior.

(For TDD discipline, this is the closest meaningful failing-first state we can reach. The build step in Task 6 is what makes the test bind. After the implementation and a build, the test will run for real.)

**Step 3: Implement the bridge**

```ts
// src/mcp/stdio.ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.js'
import { isDaemonReachable, call } from '../daemon/client.js'
import { getDaemonSocketPath } from '../daemon/paths.js'

async function main(): Promise<void> {
  const socketPath = getDaemonSocketPath()
  if (!(await isDaemonReachable(socketPath))) {
    console.error(
      `mmd-mcp: daemon not running at ${socketPath}. Start it with \`mm daemon start\` (or run \`mmd\` directly), then re-launch this MCP server.`,
    )
    process.exit(1)
  }
  const daemon = {
    call: async <R = unknown>(method: string, params: unknown): Promise<R> =>
      call<R>(socketPath, method, params),
  }
  const server = createMcpServer({ daemon })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // McpServer's connect() resolves once the transport is bound; the process
  // stays alive because stdin keeps the event loop busy. SIGTERM/SIGINT
  // trigger graceful close via the transport.
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`mmd-mcp: ${sig} received, shutting down\n`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch(err => {
  process.stderr.write(`mmd-mcp: failed to start: ${(err as Error).message}\n`)
  process.exit(1)
})
```

**Step 4: Build and run tests**

Run: `npm run build` — must produce `dist/mcp/stdio.js` with shebang preserved.
Run: `npx vitest run tests/integration/mcpStdioBridge.test.ts` — expect 2/2 pass.
Run: `npx vitest run` — full suite green.
Run: `npm run typecheck` — clean.

**Step 5: Commit**

```bash
git add src/mcp/stdio.ts tests/integration/mcpStdioBridge.test.ts
git commit -m "feat(mcp): add mmd-mcp stdio bridge to the daemon

Spawn-per-session MCP server backed by the always-on mmd daemon.
StdioServerTransport handles framing; the McpServer from src/mcp/server
provides the tool surface; each tool call proxies through the existing
NDJSON client to the daemon socket.

Probes the daemon at startup and exits 1 with a clear stderr message
if it isn't reachable — the MCP client sees a clean spawn failure
rather than a partially-initialized transport. Slice 4's installer
will check this before registering with agent configs."
```

---

## Task 5: HTTP MCP transport mounted inside `mmd`

**Why:** Agents that prefer HTTP (web-based, future remote-capable) connect to a URL instead of spawning a child. The daemon hosts the HTTP listener so it's always running alongside the Unix socket. OS-picked port + discovery file means no port conflicts and no manual config.

**Files:**
- Create: `src/mcp/http.ts` (start/stop helpers; the McpServer factory + HTTP node binding)
- Modify: `src/daemon/serverCore.ts` (start the HTTP listener after the Unix socket bind succeeds; tear down in `close()`)
- Modify: `src/daemon/paths.ts` (add `getMcpUrlPath()` returning `~/.local/share/machine-memory/mcp.url`)
- Create: `tests/integration/mcpHttpTransport.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/integration/mcpHttpTransport.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { openDatabase } from '../../src/index/db.js'
import { getMcpUrlPath } from '../../src/daemon/paths.js'

describe('mmd HTTP MCP transport', () => {
  let dir: string
  let daemon: DaemonServer | null
  let client: Client | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-http-'))
    process.env.MM_DATA_DIR = dir
    const dbPath = path.join(dir, 'machine-memory.sqlite')
    const db = openDatabase(dbPath)
    db.prepare(
      `INSERT INTO file_records (id, path, name, extension, mime_type, modified_at, source_root, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run('f1', '/tmp/thesis-intro.md', 'thesis-intro.md', 'md', 'text/markdown', '2026-04-18T10:00:00Z', '/tmp')
    db.close()
    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath,
    })
    client = null
  })

  afterEach(async () => {
    if (client) await client.close()
    if (daemon) await daemon.close()
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the discovery file with a 127.0.0.1 url on startup', () => {
    const urlPath = getMcpUrlPath()
    expect(fs.existsSync(urlPath)).toBe(true)
    const url = fs.readFileSync(urlPath, 'utf8').trim()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it('removes the discovery file on shutdown', async () => {
    const urlPath = getMcpUrlPath()
    expect(fs.existsSync(urlPath)).toBe(true)
    await daemon!.close()
    daemon = null
    expect(fs.existsSync(urlPath)).toBe(false)
  })

  it('serves mm_find over HTTP via the SDK client', async () => {
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    client = new Client({ name: 'http-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual(['mm_find', 'mm_get', 'mm_recent'])
    const res = await client.callTool({ name: 'mm_find', arguments: { query: 'thesis' } })
    expect(res.structuredContent).toMatchObject({
      query: 'thesis',
      results: [expect.objectContaining({ id: 'f1' })],
    })
  })

  it('refuses connections from non-loopback addresses', async () => {
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    const port = new URL(url).port
    // Just attempt a connect — if it ever bound to 0.0.0.0, this would succeed
    // from any local interface; we only assert the listening address through stat.
    const { default: net } = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
        socket.end()
        resolve()
      })
      socket.on('error', reject)
    })
  })
})
```

**Step 2: Run tests, confirm failure**

Run: `npx vitest run tests/integration/mcpHttpTransport.test.ts`
Expected: FAIL — `getMcpUrlPath` doesn't exist; `createServer` doesn't start an HTTP listener; the discovery file is never written.

**Step 3: Add `getMcpUrlPath()` to `src/daemon/paths.ts`**

```ts
// append to src/daemon/paths.ts
export function getMcpUrlPath(): string {
  return path.join(dataDir(), 'mcp.url')
}
```

**Step 4: Implement the HTTP listener in `src/mcp/http.ts`**

```ts
// src/mcp/http.ts
import http from 'node:http'
import fs from 'node:fs'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, type DaemonClient } from './server.js'

export type StartHttpOptions = {
  daemon: DaemonClient
  urlPath: string
}

export type HttpListener = {
  url: string
  close: () => Promise<void>
}

export async function startMcpHttp(opts: StartHttpOptions): Promise<HttpListener> {
  const httpServer = http.createServer()
  await new Promise<void>((resolve, reject) => {
    const listenError = (err: Error): void => reject(err)
    httpServer.once('error', listenError)
    // host: '127.0.0.1' enforces loopback-only; port 0 lets the OS pick free
    httpServer.listen({ host: '127.0.0.1', port: 0 }, () => {
      httpServer.off('error', listenError)
      resolve()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    httpServer.close()
    throw new Error('mmd MCP HTTP listener failed to bind to a port')
  }
  const url = `http://127.0.0.1:${address.port}/mcp`

  // The SDK's StreamableHTTPServerTransport handles request/response framing.
  // It expects to be wired into an http server's request handler.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — each request handled fresh
  })
  const server = createMcpServer({ daemon: opts.daemon })
  await server.connect(transport)

  httpServer.on('request', (req, res) => {
    if (req.url !== '/mcp') {
      res.statusCode = 404
      res.end()
      return
    }
    transport.handleRequest(req, res).catch(err => {
      res.statusCode = 500
      res.end(`mcp http error: ${(err as Error).message}\n`)
    })
  })

  fs.writeFileSync(opts.urlPath, `${url}\n`)

  return {
    url,
    close: async () => {
      try { fs.unlinkSync(opts.urlPath) } catch { /* ignore */ }
      await server.close()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    },
  }
}
```

**Step 5: Wire it into `serverCore.createServer`**

Modify `src/daemon/serverCore.ts`:

After the existing post-bind setup succeeds (chmod, pid write), add:

```ts
import { startMcpHttp, type HttpListener } from '../mcp/http.js'
import { call as daemonCall } from './client.js'
import { getMcpUrlPath } from './paths.js'

// ... inside createServer, after pid file write success:
let httpListener: HttpListener | null = null
try {
  httpListener = await startMcpHttp({
    daemon: {
      call: async <R = unknown>(method: string, params: unknown): Promise<R> =>
        daemonCall<R>(opts.socketPath, method, params),
    },
    urlPath: getMcpUrlPath(),
  })
} catch (cause) {
  // HTTP failure must tear down the rest just like a chmod failure
  await teardownPartial(server, db, opts.socketPath, opts.pidPath)
  throw new Error(`mcp http failed to start: ${(cause as Error).message}`)
}

// adjust close() to also close httpListener
return {
  socketPath: opts.socketPath,
  close: async () => {
    if (httpListener) await httpListener.close()
    // ... existing close logic
  },
}
```

(Keep the existing `teardownPartial` use; just add `httpListener?.close()` to it if you want to be paranoid about HTTP leaks during failed startup. The pattern is symmetrical to the pid-file teardown from Slice 1.)

**Step 6: Run tests, confirm pass**

Run: `npx vitest run tests/integration/mcpHttpTransport.test.ts` — expect 4/4.
Run: `npx vitest run` — full suite green.
Run: `npm run typecheck` — clean.

**Step 7: Commit**

```bash
git add src/daemon/serverCore.ts src/daemon/paths.ts src/mcp/http.ts tests/integration/mcpHttpTransport.test.ts
git commit -m "feat(mcp): mount StreamableHTTP transport inside mmd, loopback only

The daemon now also exposes its tools as MCP over HTTP at
http://127.0.0.1:<os-picked-port>/mcp. The actual URL is written to
~/.local/share/machine-memory/mcp.url on startup and removed on
shutdown so Slice 4's installer (and the curious user) can discover
it without parsing logs.

host is hard-coded to 127.0.0.1 — no remote exposure. Any other
listen address would require an explicit decision, recorded as a
later D-NNN.

The McpServer factory from src/mcp/server is reused unchanged; only
the transport differs from the stdio bridge."
```

---

## Task 6: Bin entries + npm scripts + smoke test

**Why:** Without a bin entry for `mmd-mcp`, agents can't spawn it cleanly through their config. Without an npm script, dev iteration is awkward.

**Files:**
- Modify: `package.json`

**Step 1: Add bin entry and script**

```jsonc
{
  "bin": {
    "mm":      "./dist/cli/main.js",
    "mmd":     "./dist/daemon/server.js",
    "mmd-mcp": "./dist/mcp/stdio.js"
  },
  "scripts": {
    "build":    "tsc -p tsconfig.json",
    "dev":      "tsx src/cli/main.ts",
    "daemon":   "tsx src/daemon/server.ts",
    "mcp":      "tsx src/mcp/stdio.ts",
    /* ...existing scripts unchanged... */
  }
}
```

**Step 2: Build and smoke test**

```bash
npm run build
ls -la dist/mcp/stdio.js
# Confirm shebang is preserved:
head -1 dist/mcp/stdio.js   # should print: #!/usr/bin/env node

# Bring daemon up
node dist/daemon/server.js &
sleep 1
cat ~/.local/share/machine-memory/mcp.url   # should print http://127.0.0.1:NNNNN/mcp

# Smoke the stdio bridge with the SDK's CLI client (or write a 5-line node script)
node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
;(async () => {
  const c = new Client({ name: 'smoke', version: '0' })
  const t = new StdioClientTransport({ command: 'node', args: ['dist/mcp/stdio.js'] })
  await c.connect(t)
  const tools = await c.listTools()
  console.log('tools:', tools.tools.map(t => t.name))
  const res = await c.callTool({ name: 'mm_find', arguments: { query: 'thesis' } })
  console.log('first result:', res.structuredContent?.results?.[0])
  await c.close()
})().catch(e => { console.error(e); process.exit(1) })
"

# Stop daemon
kill %1
```

Capture both the discovery file content and the smoke-test output for the validation doc in Task 8.

**Step 3: Commit**

```bash
git add package.json
git commit -m "build: register mmd-mcp bin and add npm run mcp dev script

dist/mcp/stdio.js becomes the binary that Claude Desktop / Cursor /
etc spawn when registered as an MCP server (via Slice 4's installer).
npm run mcp keeps dev iteration fast through tsx."
```

---

## Task 7: Decision log entries D-023 and D-024

**Why:** Two architectural choices were made in this slice that need to be auditable. Per the existing decision-log discipline, log them before merging.

**Files:**
- Modify: `docs/13-decision-log.md`

Append at the bottom:

```markdown
## D-023: Ship MCP over both stdio and HTTP

Decision:

- The daemon's MCP surface is exposed via TWO transports in Slice 2: a stdio bridge (`mmd-mcp` bin) and an HTTP listener inside `mmd` itself. Both mount the same `createMcpServer({daemon})` factory so tool definitions cannot drift.

Reason:

- Different MCP-speaking agents prefer different transports. Claude Desktop today is stdio-only. Newer/web-hosted clients prefer HTTP. Shipping both means Slice 4's installer can register either depending on what each detected agent supports, instead of forcing a transport choice at install time.
- Both transports were already implementable on top of the existing daemon shape: stdio bridge spawns per session and proxies via the existing NDJSON client; HTTP runs inside the daemon process via the SDK's StreamableHTTPServerTransport. The marginal complexity is a single shared factory plus two thin wiring files.
- The Unix socket NDJSON protocol stays as the daemon's internal IPC for the human CLI. MCP is the agent-facing layer. Keeping the layers distinct means we can swap or extend MCP transports later without touching `mm find`/`mm show`.

How this is applied:

- `src/mcp/server.ts` is the single source of truth for tool schemas and handlers.
- `src/mcp/stdio.ts` (bin: `mmd-mcp`) connects it to a `StdioServerTransport`. `src/mcp/http.ts` connects it to a `StreamableHTTPServerTransport` mounted inside the daemon.
- Slice 4 will register either transport with detected agent tools per D-022 (prompt-per-agent).

## D-024: HTTP MCP listens on loopback only; no token auth in v1

Decision:

- The HTTP MCP listener inside `mmd` binds to `127.0.0.1` exclusively (via Node's `host: '127.0.0.1'`) and uses no authentication.
- The OS picks the port; the actual URL is written to `~/.local/share/machine-memory/mcp.url` on startup and removed on shutdown.

Reason:

- Local-first per D-002: anything reachable from loopback already has the same trust the user gave their other local programs (e.g., editors, shells). The Unix socket is `0600`; HTTP loopback is the network-layer equivalent of that trust.
- Adding token auth at v1 would be security theater without a threat model. The real threat (network exposure) is closed by binding to 127.0.0.1.
- OS-picked port + discovery file means no port conflicts and no manual configuration. The discovery file is in the same XDG data dir as the database and the pid file; same trust boundary.

How this is applied:

- `src/mcp/http.ts` hard-codes `host: '127.0.0.1'`. Any change to this requires a follow-up D-NNN entry and an explicit user-facing config flag, because it changes the threat model.
- `mm doctor` (Slice 4 will extend it) will report the discovery file path and the bound URL so users can verify what's listening.
- If a future user wants remote access, they can run an SSH tunnel or a reverse proxy with their own auth — that's a deliberate decision, not a default.
```

Commit:

```bash
git add docs/13-decision-log.md
git commit -m "docs: log D-023 (both MCP transports) and D-024 (loopback-only HTTP)

D-023 records the choice to ship stdio + HTTP together so Slice 4's
installer has a real choice per detected agent. D-024 documents the
loopback + no-auth trust model for HTTP, with an explicit hook
requiring a future D-NNN if anyone widens the listen address."
```

---

## Task 8: Real-machine validation + slice doc

**Why:** Per D-016, every slice ship-bar gets validated against the real local machine, not just unit tests. Slice 1's validation went into `docs/24-phase-1-slice-1-validation.md`; this slice gets `docs/25-phase-1-slice-2-validation.md`.

**Files:**
- Create: `docs/25-phase-1-slice-2-validation.md`

### Step 1: Run the validation protocol

1. Make sure no daemon is running and any prior `mcp.url` is gone.
2. `npm run build`.
3. `node dist/daemon/server.js &`. Confirm `mmd listening on …` appears on stderr.
4. `cat ~/.local/share/machine-memory/mcp.url` — capture the URL.

5. **Stdio bridge end-to-end:** spawn an MCP client (use the smoke-test snippet from Task 6 or a tiny script). List tools, call `mm_find` with a query you know returns something on the real index, call `mm_get` on the top result. Capture:
   - Tools returned: should be `['mm_find', 'mm_get', 'mm_recent']`
   - First `mm_find` result id + path
   - First `resource_link` entry from `content[]`
   - `mm_get` structuredContent shape

6. **HTTP transport end-to-end:** same MCP client but use `StreamableHTTPClientTransport(new URL(<url-from-discovery-file>))`. Same three calls; same captured outputs. Diff them against the stdio outputs — the structuredContent should be identical.

7. **Discovery file lifecycle:** `kill %1` (the daemon). Confirm `mcp.url` is removed.

8. **Daemon-down bridge behavior:** with the daemon down, run `node dist/mcp/stdio.js`. Expect immediate exit 1 with the `daemon not running` message on stderr.

### Step 2: Write the validation doc

Use the same shape as `docs/24-phase-1-slice-1-validation.md`:

- Index size at validation time
- Build under test (commit list for this slice)
- For each transport: tools listed, mm_find result, mm_get result, resource_link sample
- Stdio vs HTTP: parity diff on structuredContent
- Discovery file: created, content, removed on shutdown
- Daemon-down bridge: exit code 1, stderr match
- Slice 2 ship-bar checklist (mark each item)
- Verdict: shipped or unverified
- Follow-ups surfaced

### Step 3: Commit

```bash
git add docs/25-phase-1-slice-2-validation.md
git commit -m "docs: validate Slice 2 MCP transports against real machine

Records both transports (stdio bridge spawn + HTTP via discovery file)
exercising mm_find/mm_get/mm_recent through a real MCP SDK Client
against the live local index, with structuredContent parity between
the two paths and a confirmed daemon-down failure mode for the
bridge. Slice 2 ship bar met."
```

---

## End-of-slice checklist

Before opening the PR for this slice:

- [ ] `npx vitest run` — all green (Slice 1's 80 + Slice 2's added integration + unit tests).
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` clean; `dist/mcp/stdio.js` exists with shebang.
- [ ] `cat ~/.local/share/machine-memory/mcp.url` returns a `http://127.0.0.1:N/mcp` URL while the daemon is up.
- [ ] Stdio bridge MCP smoke test green (real SDK Client).
- [ ] HTTP transport MCP smoke test green.
- [ ] Validation doc committed (`docs/25-phase-1-slice-2-validation.md`).
- [ ] D-023 and D-024 in decision log.
- [ ] Branch `phase-1-slice-2` pushed.
- [ ] PR opened against `main` with body summarizing ship-bar items met.

If any item is incomplete, label slice "implemented but unverified" and stop.

---

## Open work explicitly deferred to later slices

- `mm_chat` MCP tool — Phase 4.
- `mm_subscribe` streaming MCP tool — bundled with Slice 3's watcher.
- Activity-event-backed `mm_recent` — Phase 2.
- Slice 4's `npx machine-memory init` will: detect agent configs, prompt per agent (D-022), pick stdio or HTTP based on what each agent prefers, write the registration entry, kick off first scan.
- `mm doctor` extension to surface discovery URL + listener health (lands with Slice 4).
- HTTP token auth — will not land unless and until a real threat model needs it (per D-024).
