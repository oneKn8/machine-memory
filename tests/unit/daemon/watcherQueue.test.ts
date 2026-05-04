import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDebouncer,
  createWriterQueue,
  type DebouncedJob,
} from '../../../src/daemon/watcherQueue.js'
import type { Stats } from 'node:fs'

const fakeStats = { size: 0, mtimeMs: 0, ino: 0, dev: 0 } as unknown as Stats

describe('createDebouncer', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces 5 change events for the same path into a single upsert job', async () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 250, onJob: j => jobs.push(j) })

    for (let i = 0; i < 5; i++) {
      d.enqueue({ kind: 'change', path: '/tmp/burst.md', stats: fakeStats })
      vi.advanceTimersByTime(20) // 100 ms total elapsed
    }
    expect(jobs.length).toBe(0)
    vi.advanceTimersByTime(250)  // past the debounce window
    expect(jobs).toEqual([{ kind: 'upsert', path: '/tmp/burst.md' }])
  })

  it('latest-event-wins: unlink overrides a pending change for the same path', async () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 250, onJob: j => jobs.push(j) })

    d.enqueue({ kind: 'change', path: '/tmp/x.md', stats: fakeStats })
    vi.advanceTimersByTime(50)
    d.enqueue({ kind: 'unlink', path: '/tmp/x.md' })
    vi.advanceTimersByTime(250)
    expect(jobs).toEqual([{ kind: 'delete', path: '/tmp/x.md' }])
  })

  it('maxDelayMs forces emission even if events keep arriving', async () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 100, maxDelayMs: 500, onJob: j => jobs.push(j) })

    // Fire an event every 50 ms — under debounceMs, so without the
    // maxDelay safety the debouncer would never fire.
    for (let i = 0; i < 12; i++) {
      d.enqueue({ kind: 'change', path: '/tmp/never-quiet.md', stats: fakeStats })
      vi.advanceTimersByTime(50)
    }
    // 12 * 50 = 600 ms total; maxDelay (500 ms) should have forced one
    // job by now and we may have queued more after.
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    expect(jobs[0]).toEqual({ kind: 'upsert', path: '/tmp/never-quiet.md' })
  })

  it('different paths debounce independently', async () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 100, onJob: j => jobs.push(j) })

    d.enqueue({ kind: 'change', path: '/a.md', stats: fakeStats })
    d.enqueue({ kind: 'change', path: '/b.md', stats: fakeStats })
    vi.advanceTimersByTime(150)
    expect(jobs.length).toBe(2)
    expect(jobs.map(j => j.path).sort()).toEqual(['/a.md', '/b.md'])
  })

  it('flushAll() fires every pending timer immediately (used by shutdown)', () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 1000, onJob: j => jobs.push(j) })

    d.enqueue({ kind: 'change', path: '/a.md', stats: fakeStats })
    d.enqueue({ kind: 'change', path: '/b.md', stats: fakeStats })
    expect(jobs.length).toBe(0)
    d.flushAll()
    expect(jobs.length).toBe(2)
  })

  it('error events are silently ignored (handled by Task 5 daemon counter)', async () => {
    vi.useFakeTimers()
    const jobs: DebouncedJob[] = []
    const d = createDebouncer({ debounceMs: 100, onJob: j => jobs.push(j) })

    d.enqueue({ kind: 'error', error: new Error('inotify watch limit') })
    vi.advanceTimersByTime(500)
    expect(jobs).toEqual([])
  })
})

describe('createWriterQueue', () => {
  it('drains queued tasks inside one transaction per pass', async () => {
    const txCalls: number[] = []
    const applied: string[] = []
    const q = createWriterQueue({
      runTransaction: work => { txCalls.push(Date.now()); work() },
      drainTickMs: 1000,  // disable tick; we rely on the empty->non-empty drain
    })
    q.push({ apply: () => applied.push('a') })
    q.push({ apply: () => applied.push('b') })
    q.push({ apply: () => applied.push('c') })
    await q.flush()
    expect(applied).toEqual(['a', 'b', 'c'])
    expect(txCalls.length).toBe(1)  // one transaction wrapped all three
    q.close()
  })

  it('calls onPause when crossing highWatermark and onResume when draining below lowWatermark', async () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    const q = createWriterQueue({
      runTransaction: work => work(),
      drainTickMs: 1000,
      highWatermark: 3,
      lowWatermark: 1,
      onPause,
      onResume,
    })
    q.push({ apply: () => {} })
    q.push({ apply: () => {} })
    expect(onPause).not.toHaveBeenCalled()
    q.push({ apply: () => {} })
    expect(onPause).toHaveBeenCalledTimes(1)
    await q.flush()
    expect(onResume).toHaveBeenCalledTimes(1)
    q.close()
  })

  it('hardCap drops oldest into dirty-paths set when overflowed', async () => {
    const q = createWriterQueue({
      runTransaction: work => work(),
      drainTickMs: 100000,  // suppress automatic drain
      hardCap: 2,
    })
    q.push({ apply: () => {}, path: '/a.md' })
    q.push({ apply: () => {}, path: '/b.md' })
    // Third push exceeds hardCap → drop oldest (/a.md), stash its path.
    q.push({ apply: () => {}, path: '/c.md' })
    expect(q.takeDirtyPaths()).toEqual(['/a.md'])
    // Calling takeDirtyPaths twice returns empty (it's a take, not a peek).
    expect(q.takeDirtyPaths()).toEqual([])
    q.close()
  })

  it('flush() resolves after pending drain runs', async () => {
    const applied: string[] = []
    const q = createWriterQueue({
      runTransaction: work => work(),
      drainTickMs: 100000,
    })
    q.push({ apply: () => applied.push('one') })
    await q.flush()
    expect(applied).toEqual(['one'])
    q.close()
  })

  it('push after close() is a no-op', async () => {
    const applied: string[] = []
    const q = createWriterQueue({
      runTransaction: work => work(),
      drainTickMs: 100000,
    })
    q.close()
    q.push({ apply: () => applied.push('after-close') })
    await q.flush().catch(() => {/* drain on closed is fine */})
    expect(applied).toEqual([])
  })
})
