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

  it('lists tools and serves mm_find via the bridge over stdio', async () => {
    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
      // Hard fail rather than silent skip: a clean checkout that runs `npm
      // test` should not be able to claim transport coverage without actually
      // exercising the bridge. CI in particular must run the build step first.
      throw new Error(
        `mmd-mcp bridge not built at ${bridgeScript} — run \`npm run build\` before \`npm test\``,
      )
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
    await daemon!.close()
    daemon = null

    const bridgeScript = path.resolve('dist/mcp/stdio.js')
    if (!fs.existsSync(bridgeScript)) {
      // Hard fail rather than silent skip: a clean checkout that runs `npm
      // test` should not be able to claim transport coverage without actually
      // exercising the bridge. CI in particular must run the build step first.
      throw new Error(
        `mmd-mcp bridge not built at ${bridgeScript} — run \`npm run build\` before \`npm test\``,
      )
    }
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [bridgeScript], {
      env: { ...process.env, MM_DATA_DIR: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const exitCode = await new Promise<number>((resolve, reject) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('mmd-mcp did not exit within 3s; killed'))
      }, 3000)
      child.on('exit', code => {
        clearTimeout(killer)
        resolve(code ?? -1)
      })
    })
    expect(exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/daemon not running/i)
  })
})
