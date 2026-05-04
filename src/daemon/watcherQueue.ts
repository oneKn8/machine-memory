// Slice 3 Task 4 — debouncer + writer queue primitives.
//
// Two independent components live here:
//
// 1. createDebouncer: per-path coalescer. The watcher fires a burst of
//    chokidar events for a single editor save (vim swap dance, atomic
//    rename, multi-step writers). Without coalescing we'd extract the
//    same file 3-5 times. The debouncer waits debounceMs after the
//    LAST event for a path, then emits ONE coalesced job. A maxDelayMs
//    cap forces emission even if events keep arriving (a tail-latency
//    safety net for files that never quiesce).
//
// 2. createWriterQueue: single-consumer FIFO drained on the main thread,
//    with one SQLite transaction per drain pass. Drains either when the
//    queue goes 0 → >0 or every drainTickMs (50 ms safety tick). On
//    cap-approach the queue calls onPause / onResume so the producer
//    (the watcher debouncer) can backpressure. NEVER drops newest —
//    plan revision moved away from "drop oldest on cap" because the
//    fingerprint-reuse short-circuit would silently lie about freshness.
//
// Cross-path rename pairing + atomic-rename collapse + delete-grace
// expiry live in Task 6 (a layer above this file). This file is the
// substrate; Task 6 builds the rename + delete logic on top of it.

import type { WatcherEvent } from './watcher.js'

export type DebouncedJob =
  | { kind: 'upsert'; path: string }   // add or change collapsed to upsert
  | { kind: 'delete'; path: string }

export type CreateDebouncerOptions = {
  debounceMs?: number
  maxDelayMs?: number
  onJob: (job: DebouncedJob) => void
}

export type Debouncer = {
  enqueue(event: WatcherEvent): void
  // Force-flush every pending timer (used by daemon shutdown step 3).
  flushAll(): void
  // Cancel every pending timer without firing (test cleanup).
  clear(): void
}

type PendingState = {
  latestKind: 'upsert' | 'delete'
  firstReceivedAt: number
  timer: NodeJS.Timeout
}

export function createDebouncer(opts: CreateDebouncerOptions): Debouncer {
  const debounceMs = opts.debounceMs ?? 250
  const maxDelayMs = opts.maxDelayMs ?? 2000
  const pending = new Map<string, PendingState>()

  function fire(path: string, state: PendingState): void {
    pending.delete(path)
    clearTimeout(state.timer)
    opts.onJob({ kind: state.latestKind, path })
  }

  function schedule(path: string, kind: 'upsert' | 'delete'): void {
    const existing = pending.get(path)
    const now = Date.now()
    if (existing) {
      // Latest-event-wins per plan §watcherQueue. An incoming unlink
      // overrides a pending upsert: extracting a file that's already
      // been deleted is wasted work.
      existing.latestKind = kind
      clearTimeout(existing.timer)
      const elapsed = now - existing.firstReceivedAt
      const remainingBudget = maxDelayMs - elapsed
      const delay = Math.max(0, Math.min(debounceMs, remainingBudget))
      existing.timer = setTimeout(() => fire(path, existing), delay)
      return
    }
    const state: PendingState = {
      latestKind: kind,
      firstReceivedAt: now,
      timer: setTimeout(() => fire(path, state), debounceMs),
    }
    pending.set(path, state)
  }

  return {
    enqueue(event) {
      switch (event.kind) {
        case 'add':
        case 'change':
          schedule(event.path, 'upsert')
          break
        case 'unlink':
          schedule(event.path, 'delete')
          break
        case 'error':
          // Errors are not jobs; the daemon's error counter handles them
          // (Task 5 Step 5). Debouncer ignores.
          break
      }
    },
    flushAll() {
      // Snapshot — fire() mutates the map.
      const entries = [...pending.entries()]
      for (const [path, state] of entries) fire(path, state)
    },
    clear() {
      for (const state of pending.values()) clearTimeout(state.timer)
      pending.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Writer queue
// ---------------------------------------------------------------------------

export type WriterTask = {
  // Caller-provided apply function. The queue invokes it inside one
  // SQLite transaction per drain pass — caller does the actual UPSERT
  // / DELETE work against the db it closed over. The queue does not
  // know about better-sqlite3.
  apply(): void
  // Optional path tag for diagnostics + dirty-paths set on drop.
  path?: string
}

export type CreateWriterQueueOptions = {
  // The transaction wrapper the queue uses to apply a drain batch.
  // Pass `db.transaction(fn => fn())` from better-sqlite3.
  runTransaction: (work: () => void) => void
  drainTickMs?: number          // safety drain interval, default 50 ms
  highWatermark?: number        // queue length at which we ask producer to pause
  lowWatermark?: number         // queue length at which we tell producer to resume
  hardCap?: number              // queue length at which dropped tasks land in dirty-paths set
  onPause?: () => void          // producer should stop submitting
  onResume?: () => void         // producer can resume
}

export type WriterQueue = {
  push(task: WriterTask): void
  // Force a drain right now and await its completion (used by daemon
  // shutdown step 5 — flush before close).
  flush(): Promise<void>
  // Dirty-paths set: paths whose tasks were dropped at hardCap. Caller
  // re-enqueues them as synthetic change events on next opportunity so
  // the fingerprint reuse path can't silently lie.
  takeDirtyPaths(): string[]
  size(): number
  close(): void
}

export function createWriterQueue(opts: CreateWriterQueueOptions): WriterQueue {
  const drainTickMs = opts.drainTickMs ?? 50
  const highWatermark = opts.highWatermark ?? 5000
  const lowWatermark = opts.lowWatermark ?? 2500
  const hardCap = opts.hardCap ?? 10000

  const queue: WriterTask[] = []
  const dirtyPaths = new Set<string>()
  let paused = false
  let closed = false
  let tickHandle: NodeJS.Timeout | null = setInterval(drain, drainTickMs)
  if (tickHandle.unref) tickHandle.unref()

  function drain(): void {
    if (closed || queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    opts.runTransaction(() => {
      for (const task of batch) task.apply()
    })
    if (paused && queue.length <= lowWatermark) {
      paused = false
      opts.onResume?.()
    }
  }

  return {
    push(task) {
      if (closed) return
      if (queue.length >= hardCap) {
        // Queue overflow: do NOT drop newest (newer = more recent truth).
        // Instead, drop the OLDEST queued task and stash its path in the
        // dirty-paths set so the caller can re-enqueue it later. This
        // way the caller still gets the latest mutation while losing
        // only the redundant earlier one.
        const dropped = queue.shift()
        if (dropped?.path) dirtyPaths.add(dropped.path)
      }
      queue.push(task)
      // Drain immediately on transition from empty (avoids waiting for
      // the next tick when traffic is sparse).
      if (queue.length === 1) {
        // Defer to next tick so the caller can push more in the same
        // microtask without us drain-per-call.
        setImmediate(drain)
      }
      if (!paused && queue.length >= highWatermark) {
        paused = true
        opts.onPause?.()
      }
    },
    flush() {
      return new Promise<void>(resolve => {
        // Drain synchronously (better-sqlite3 is sync), then resolve
        // on the next tick so any setImmediate-scheduled drain has run.
        drain()
        setImmediate(resolve)
      })
    },
    takeDirtyPaths() {
      const out = [...dirtyPaths]
      dirtyPaths.clear()
      return out
    },
    size: () => queue.length,
    close() {
      closed = true
      if (tickHandle) {
        clearInterval(tickHandle)
        tickHandle = null
      }
    },
  }
}
