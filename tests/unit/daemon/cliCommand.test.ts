import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { runDaemonStatus, runDaemonStop } from '../../../src/cli/commands/daemon.js'

describe('mm daemon status', () => {
  let dir: string
  let logs: string[]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cmd-'))
    process.env.MM_DATA_DIR = dir
    logs = []
    vi.spyOn(console, 'log').mockImplementation(line => {
      logs.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation(line => {
      logs.push(String(line))
    })
  })
  afterEach(() => {
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reports stopped when no pid file and no socket exist', async () => {
    await runDaemonStatus()
    expect(logs.join('\n')).toMatch(/stopped/i)
  })

  it('reports stale when pid file points at non-existent process', async () => {
    fs.writeFileSync(path.join(dir, 'mmd.pid'), '99999999')
    await runDaemonStatus()
    expect(logs.join('\n')).toMatch(/stale/i)
  })

  it('stop is a no-op when no pid file exists', async () => {
    await expect(runDaemonStop()).resolves.toBeUndefined()
    expect(logs.join('\n')).toMatch(/not running/i)
  })
})
