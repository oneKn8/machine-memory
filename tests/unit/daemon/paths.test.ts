import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { getDaemonPidPath, getDaemonSocketPath } from '../../../src/daemon/paths.js'

describe('daemon paths', () => {
  const originalDataDir = process.env.MM_DATA_DIR
  beforeEach(() => { delete process.env.MM_DATA_DIR })
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MM_DATA_DIR
    else process.env.MM_DATA_DIR = originalDataDir
  })

  it('defaults socket and pid under XDG data dir', () => {
    const expectedDir = path.join(os.homedir(), '.local', 'share', 'machine-memory')
    expect(getDaemonSocketPath()).toBe(path.join(expectedDir, 'mmd.sock'))
    expect(getDaemonPidPath()).toBe(path.join(expectedDir, 'mmd.pid'))
  })

  it('honors MM_DATA_DIR override', () => {
    process.env.MM_DATA_DIR = '/tmp/mm-test-paths'
    expect(getDaemonSocketPath()).toBe('/tmp/mm-test-paths/mmd.sock')
    expect(getDaemonPidPath()).toBe('/tmp/mm-test-paths/mmd.pid')
  })
})
