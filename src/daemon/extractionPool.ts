import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import type {
  ExtractionJobOptions,
  ExtractionJobResult,
  WorkerInbound,
  WorkerOutbound,
} from './extractionWorker.js'

export type ExtractionPool = {
  extract(filePath: string, options: ExtractionJobOptions): Promise<ExtractionJobResult>
  close(): Promise<void>
  // Diagnostic: number of workers currently alive. Exposed for tests; not
  // an API the daemon should program against.
  size(): number
}

export type ExtractionPoolOptions = {
  size: number
  // Max queued jobs before extract() rejects with EXTRACTION_QUEUE_FULL.
  // Defaults to 4 * size per Slice 3 plan Task 2 Step 1.
  maxQueueLength?: number
  // Override the worker entry path (tests use this to point at a stub).
  workerEntry?: URL
}

export class ExtractionPoolClosedError extends Error {
  code = 'EXTRACTION_POOL_CLOSED' as const
  constructor() { super('extraction pool is closed') }
}

export class ExtractionQueueFullError extends Error {
  code = 'EXTRACTION_QUEUE_FULL' as const
  constructor(limit: number) { super(`extraction queue is full (limit=${limit})`) }
}

export class ExtractionWorkerError extends Error {
  code = 'EXTRACTION_WORKER_ERROR' as const
  constructor(message: string) { super(message) }
}

/**
 * Pool size for the extraction workers.
 *
 * Per Slice 3 plan Task 2: `min(4, cpuCount - 1)`. Cap at 4 because
 * extraction is mostly I/O-dominated (PDF parse, image OCR), so 4
 * workers saturate typical SSD seek throughput; capping protects
 * many-core dev boxes from spawning 31 idle workers. Subtract one to
 * reserve a core for the main thread (RPC + writer queue + chokidar).
 *
 * Floor at 1 — a 1-core box (or `availableParallelism()` returning 1)
 * still gets a worker; the size-1 case is a degenerate but legitimate
 * shape that must work.
 */
export function defaultExtractionPoolSize(): number {
  const cpus = availableParallelism()
  return Math.max(1, Math.min(4, cpus - 1))
}

type PendingJob = {
  jobId: number
  filePath: string
  options: ExtractionJobOptions
  resolve: (r: ExtractionJobResult) => void
  reject: (err: Error) => void
}

type WorkerSlot = {
  worker: Worker
  busy: PendingJob | null
  ready: Promise<void>
}

export function createExtractionPool(opts: ExtractionPoolOptions): ExtractionPool {
  if (opts.size < 1) throw new Error(`extraction pool size must be >= 1 (got ${opts.size})`)
  const maxQueueLength = opts.maxQueueLength ?? opts.size * 4

  // Resolve the worker entry. Always uses the compiled dist/ JS, even in
  // dev/tests — Node Worker's execArgv option does NOT accept `--import`
  // flags (verified empirically), so there's no way to load tsx into a
  // worker thread to handle .ts source. Same hard-fail policy as the
  // stdio MCP bridge: a clean checkout running `npm test` must run
  // `npm run build` first or the missing artifact stops it loudly.
  const distRoot = import.meta.url.endsWith('.ts')
    ? new URL('../../dist/daemon/', import.meta.url)
    : new URL('./', import.meta.url)
  const defaultEntry = new URL('extractionWorker.js', distRoot)
  const workerEntry = opts.workerEntry ?? defaultEntry
  if (!fs.existsSync(workerEntry)) {
    throw new Error(
      `extraction worker not built at ${path.resolve(workerEntry.pathname)} — run \`npm run build\` before constructing an extraction pool`,
    )
  }
  const workerExecArgv = process.execArgv

  let nextJobId = 1
  let closed = false
  let drainResolve: (() => void) | null = null

  const queue: PendingJob[] = []
  const slots: WorkerSlot[] = []

  function dispatch(slot: WorkerSlot): void {
    if (closed && queue.length === 0) {
      maybeResolveDrain()
      return
    }
    if (slot.busy) return
    const job = queue.shift()
    if (!job) {
      maybeResolveDrain()
      return
    }
    slot.busy = job
    const msg: WorkerInbound = {
      kind: 'extract',
      jobId: job.jobId,
      filePath: job.filePath,
      options: job.options,
    }
    slot.worker.postMessage(msg)
  }

  function maybeResolveDrain(): void {
    if (!closed || drainResolve === null) return
    if (queue.length === 0 && slots.every(s => s.busy === null)) {
      const resolve = drainResolve
      drainResolve = null
      resolve()
    }
  }

  function spawnWorker(): WorkerSlot {
    // execArgv resolved above — adds --import tsx in dev/test, empty in prod.
    const worker = new Worker(workerEntry, { execArgv: workerExecArgv })
    const ready = new Promise<void>((resolve, reject) => {
      const onMsg = (m: WorkerOutbound): void => {
        if (m.kind === 'ready') {
          worker.off('message', onMsg)
          resolve()
        }
      }
      worker.on('message', onMsg)
      worker.once('error', reject)
    })
    const slot: WorkerSlot = { worker, busy: null, ready }

    worker.on('message', (m: WorkerOutbound) => {
      if (m.kind === 'ready') return
      const inflight = slot.busy
      if (!inflight) return                   // stray or post-shutdown message
      if (m.kind === 'result' && m.jobId === inflight.jobId) {
        slot.busy = null
        inflight.resolve(m.result)
      } else if (m.kind === 'error' && m.jobId === inflight.jobId) {
        slot.busy = null
        inflight.reject(new ExtractionWorkerError(m.message))
      }
      dispatch(slot)
    })

    worker.on('error', err => {
      const inflight = slot.busy
      slot.busy = null
      if (inflight) inflight.reject(err)
      // A worker that errored is gone; do not respawn for now (caller can
      // close + recreate the pool). Slice 3 plan Task 5 Step 5 handles the
      // counter/degraded-state wiring at the daemon level.
    })

    return slot
  }

  for (let i = 0; i < opts.size; i++) slots.push(spawnWorker())

  function extract(filePath: string, options: ExtractionJobOptions): Promise<ExtractionJobResult> {
    if (closed) return Promise.reject(new ExtractionPoolClosedError())
    return new Promise<ExtractionJobResult>((resolve, reject) => {
      const job: PendingJob = { jobId: nextJobId++, filePath, options, resolve, reject }
      // Claim an idle slot synchronously if available. Marking `busy`
      // before the slot's `ready` promise resolves prevents a parallel
      // extract() call from also claiming the same slot or from seeing
      // the queue as falsely-full because the cap-check happens before
      // dispatch had a chance to drain.
      for (const slot of slots) {
        if (slot.busy) continue
        slot.busy = job
        slot.ready.then(() => {
          const msg: WorkerInbound = {
            kind: 'extract',
            jobId: job.jobId,
            filePath: job.filePath,
            options: job.options,
          }
          slot.worker.postMessage(msg)
        }).catch(err => {
          slot.busy = null
          reject(err)
          dispatch(slot)
        })
        return
      }
      // All slots busy → queue, subject to backpressure cap.
      if (queue.length >= maxQueueLength) {
        reject(new ExtractionQueueFullError(maxQueueLength))
        return
      }
      queue.push(job)
    })
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    // Wait for in-flight + queued work to finish naturally. New extract()
    // calls reject immediately (closed === true above).
    await new Promise<void>(resolve => {
      drainResolve = resolve
      maybeResolveDrain()
    })
    // Now post shutdown to each worker and await its exit.
    await Promise.all(slots.map(slot => new Promise<void>(resolve => {
      slot.worker.once('exit', () => resolve())
      const msg: WorkerInbound = { kind: 'shutdown' }
      slot.worker.postMessage(msg)
      // Safety: if a worker doesn't exit in 2 s, terminate it.
      const t = setTimeout(() => {
        slot.worker.terminate().finally(() => resolve())
      }, 2000)
      slot.worker.once('exit', () => clearTimeout(t))
    })))
  }

  return {
    extract,
    close,
    size: () => slots.length,
  }
}
