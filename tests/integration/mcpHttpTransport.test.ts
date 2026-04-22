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

  it('binds to 127.0.0.1 only', async () => {
    const url = fs.readFileSync(getMcpUrlPath(), 'utf8').trim()
    const port = new URL(url).port
    const { default: net } = await import('node:net')
    // Loopback connect should succeed
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
        socket.end()
        resolve()
      })
      socket.on('error', reject)
    })
  })
})
