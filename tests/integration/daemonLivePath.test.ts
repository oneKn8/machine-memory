import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { call as daemonCall } from '../../src/daemon/client.js'
import type { SearchResult } from '../../src/types.js'

// Slice 3 Task 5 — end-to-end live-path test. This is the slice's
// center of gravity per the plan: "if it fails, the slice is not done."
//
// Spins up a real daemon with a real chokidar watcher, real worker pool
// (requires dist/ — same hard-fail policy as the stdio bridge), real
// SQLite. Touches a file under the watch root. Asserts that within the
// 5 s ship bar, mm_find returns the file.

function waitFor<T>(predicate: () => Promise<T | null | undefined>, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now()
    const tick = async (): Promise<void> => {
      try {
        const v = await predicate()
        if (v) return resolve(v)
      } catch {
        /* swallow — predicate may transiently fail during startup */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout after ${timeoutMs}ms`))
      setTimeout(() => { void tick() }, 50)
    }
    void tick()
  })
}

describe('mmd live-indexing path (Slice 3 Task 5)', () => {
  let dir: string
  let watchRoot: string
  let daemon: DaemonServer | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-'))
    process.env.MM_DATA_DIR = dir
    watchRoot = path.join(dir, 'roots')
    fs.mkdirSync(watchRoot, { recursive: true })

    // Pool construction needs the built dist worker. Hard-fail loudly,
    // matching the stdio bridge test's policy.
    const workerPath = path.resolve('dist/daemon/extractionWorker.js')
    if (!fs.existsSync(workerPath)) {
      throw new Error(
        `extraction worker not built at ${workerPath} — run \`npm run build\` before \`npm test\``,
      )
    }

    daemon = await createServer({
      socketPath: path.join(dir, 'mmd.sock'),
      pidPath: path.join(dir, 'mmd.pid'),
      dbPath: path.join(dir, 'machine-memory.sqlite'),
      roots: [watchRoot],
    })
  })

  afterEach(async () => {
    if (daemon) await daemon.close()
    delete process.env.MM_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('indexes a freshly-written file within the 5 s ship bar', async () => {
    const filePath = path.join(watchRoot, 'live-note.md')
    fs.writeFileSync(filePath, 'live indexing proof: thesis raptor zebra')

    // Wait for the daemon to surface the file via mm_find. We probe
    // every 50 ms via the unix-socket RPC — this is the same call path
    // the CLI uses (mm find), so a green here means the agent-facing
    // surface reflects the watcher's writes.
    const found = await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'thesis raptor' })
      return results.find(r => r.path === filePath) ?? null
    }, 5000)

    expect(found.path).toBe(filePath)
    expect(found.resultType).toBe('file')
  })

  it('reflects a delete via unlink → mm_find no longer returns the path', async () => {
    const filePath = path.join(watchRoot, 'doomed.md')
    fs.writeFileSync(filePath, 'this file is doomed thesis raptor')

    // Wait for it to be indexed first.
    await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'doomed' })
      return results.find(r => r.path === filePath) ?? null
    }, 5000)

    // Delete it.
    fs.unlinkSync(filePath)

    // Wait for the unlink to propagate (1 s rename grace + debounce + writer drain).
    await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'doomed' })
      // Expect predicate to return truthy when the file is GONE, so we
      // return a sentinel object once results no longer include it.
      return results.find(r => r.path === filePath) ? null : { ok: true }
    }, 5000)
  })

  it('mv a.md b.md updates the existing row in place via inode pairing (closes F-011)', async () => {
    // Seed the corpus and wait for indexing.
    const oldPath = path.join(watchRoot, 'before-rename.md')
    const newPath = path.join(watchRoot, 'after-rename.md')
    fs.writeFileSync(oldPath, 'rename target raptor zebra unique-token-XYZZY')
    await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'XYZZY' })
      return results.find(r => r.path === oldPath) ?? null
    }, 5000)

    // Rename. mv preserves inode within a single filesystem.
    fs.renameSync(oldPath, newPath)

    // After the rename: mm_find for the unique token returns the NEW
    // path, NOT the old, and the result count is exactly 1 (not 2 — no
    // ghost row).
    const found = await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'XYZZY' })
      const atNew = results.find(r => r.path === newPath)
      const atOld = results.find(r => r.path === oldPath)
      if (atNew && !atOld) return { atNew, count: results.filter(r => r.path === newPath || r.path === oldPath).length }
      return null
    }, 5000)
    expect(found.atNew.path).toBe(newPath)
    expect(found.count).toBe(1)
  })

  it('rename does not orphan text_blobs / FTS rows for the old id (sidecar-orphan regression)', async () => {
    // Same as above but verifies via direct DB inspection that the old
    // id has zero rows in text_blobs and text_blobs_fts post-rename.
    const oldPath = path.join(watchRoot, 'orphan-check.md')
    const newPath = path.join(watchRoot, 'orphan-check-renamed.md')
    fs.writeFileSync(oldPath, 'orphan check unique-marker-ABCDE')
    await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'ABCDE' })
      return results.find(r => r.path === oldPath) ?? null
    }, 5000)

    fs.renameSync(oldPath, newPath)

    await waitFor(async () => {
      const results = await daemonCall<SearchResult[]>(daemon!.socketPath, 'mm_find', { query: 'ABCDE' })
      return results.find(r => r.path === newPath) ?? null
    }, 5000)

    // Open a read-only handle to the same DB to inspect sidecar state.
    // Use a fresh sqlite connection (the daemon owns the writer).
    const Database = (await import('better-sqlite3')).default
    const ro = new Database(path.join(dir, 'machine-memory.sqlite'), { readonly: true })
    try {
      const { createHash } = await import('node:crypto')
      const oldId = createHash('sha1').update(oldPath).digest('hex')
      const newId = createHash('sha1').update(newPath).digest('hex')

      const oldBlobs = ro.prepare(
        `SELECT COUNT(*) AS c FROM text_blobs WHERE source_id = ? AND source_type = 'file'`,
      ).get(oldId) as { c: number }
      const oldFts = ro.prepare(
        `SELECT COUNT(*) AS c FROM text_blobs_fts WHERE source_id = ? AND source_type = 'file'`,
      ).get(oldId) as { c: number }
      const newBlobs = ro.prepare(
        `SELECT COUNT(*) AS c FROM text_blobs WHERE source_id = ? AND source_type = 'file'`,
      ).get(newId) as { c: number }
      const newFts = ro.prepare(
        `SELECT COUNT(*) AS c FROM text_blobs_fts WHERE source_id = ? AND source_type = 'file'`,
      ).get(newId) as { c: number }

      expect(oldBlobs.c, 'text_blobs orphaned for old id after rename').toBe(0)
      expect(oldFts.c, 'text_blobs_fts orphaned for old id after rename').toBe(0)
      expect(newBlobs.c, 'text_blobs not migrated to new id').toBeGreaterThan(0)
      expect(newFts.c, 'text_blobs_fts not re-emitted for new id').toBeGreaterThan(0)
    } finally {
      ro.close()
    }
  })
})
