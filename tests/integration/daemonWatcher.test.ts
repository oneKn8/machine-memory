import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWatcher, type WatcherEvent, type WatcherHandle } from '../../src/daemon/watcher.js'

// Slice 3 Task 3 — chokidar watcher integration test.
// Spins up a real watcher on a real mkdtemp directory, mutates files,
// and asserts the right events arrive in the right order. Uses a
// shorter awaitWriteFinish so the test finishes in well under 1 s.

const SHORT_AWF = { stabilityThreshold: 50, pollInterval: 10 }

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      const v = predicate()
      if (v !== undefined) return resolve(v)
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout after ${timeoutMs}ms`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('createWatcher', () => {
  let dir: string
  let handle: WatcherHandle | null
  let events: WatcherEvent[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-watcher-'))
    handle = null
    events = []
  })

  afterEach(async () => {
    if (handle) await handle.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function startWatcher(extra?: { ignored?: string[] }): Promise<void> {
    handle = createWatcher({
      roots: [dir],
      ignored: extra?.ignored,
      awaitWriteFinish: SHORT_AWF,
      onEvent: e => events.push(e),
    })
    await handle.ready
  }

  it('emits add then change then unlink for a single file lifecycle', async () => {
    await startWatcher()
    const filePath = path.join(dir, 'note.md')

    fs.writeFileSync(filePath, 'first')
    const addEv = await waitFor(() => events.find(e => e.kind === 'add' && e.path === filePath))
    expect(addEv.kind).toBe('add')
    if (addEv.kind === 'add') {
      expect(addEv.stats.size).toBe(5)
    }

    fs.writeFileSync(filePath, 'second pass')
    const changeEv = await waitFor(() => events.find(e => e.kind === 'change' && e.path === filePath))
    expect(changeEv.kind).toBe('change')

    fs.unlinkSync(filePath)
    const unlinkEv = await waitFor(() => events.find(e => e.kind === 'unlink' && e.path === filePath))
    expect(unlinkEv.kind).toBe('unlink')
  })

  it('does not emit for files matching the ignore predicate', async () => {
    // Use a single glob that matches a specific filename rather than the
    // full DEFAULT_EXCLUDE_GLOBS (which includes node_modules etc — fine
    // but heavier). Picomatch with `**/ignored.md` matches the file at
    // any depth.
    await startWatcher({ ignored: ['**/ignored.md'] })

    const ignoredPath = path.join(dir, 'ignored.md')
    const seenPath = path.join(dir, 'seen.md')
    fs.writeFileSync(ignoredPath, 'should not show up')
    fs.writeFileSync(seenPath, 'should show up')

    // Wait for the seen file's add to arrive, then assert no event
    // mentions the ignored file.
    await waitFor(() => events.find(e => e.kind === 'add' && e.path === seenPath))
    // Give the watcher a moment to (not) emit anything for the ignored file.
    await new Promise(r => setTimeout(r, 100))
    expect(events.find(e => 'path' in e && e.path === ignoredPath)).toBeUndefined()
  })

  it('alwaysStat is enabled — add/change events carry a Stats object with mtime, size, ino, dev', async () => {
    await startWatcher()
    const filePath = path.join(dir, 'stat-check.md')
    fs.writeFileSync(filePath, 'hello stats')
    const ev = await waitFor(() => events.find(e => e.kind === 'add' && e.path === filePath))
    expect(ev.kind).toBe('add')
    if (ev.kind === 'add') {
      // These four are the ones Slice 3 actually depends on. ino + dev
      // power Task 6's rename pairing; mtime + size power the
      // fingerprint reuse short-circuit.
      expect(ev.stats.mtimeMs).toBeGreaterThan(0)
      expect(ev.stats.size).toBe(11)
      expect(typeof ev.stats.ino).toBe('number')
      expect(typeof ev.stats.dev).toBe('number')
    }
  })

  it('close() resolves and is idempotent for repeat calls', async () => {
    await startWatcher()
    await handle!.close()
    // A second close should not throw — chokidar handles redundant close.
    await expect(handle!.close()).resolves.not.toThrow()
    handle = null  // already closed
  })
})
