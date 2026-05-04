import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createExtractionPool,
  defaultExtractionPoolSize,
  ExtractionPoolClosedError,
  ExtractionQueueFullError,
  type ExtractionPool,
} from '../../../src/daemon/extractionPool.js'

describe('defaultExtractionPoolSize', () => {
  it('returns at least 1 even on a single-CPU machine', () => {
    // We can't mock availableParallelism easily without complex hoisting;
    // assert the floor invariant on whatever the real CPU count is.
    expect(defaultExtractionPoolSize()).toBeGreaterThanOrEqual(1)
  })

  it('caps at 4 even on many-core boxes', () => {
    expect(defaultExtractionPoolSize()).toBeLessThanOrEqual(4)
  })
})

describe('createExtractionPool', () => {
  let dir: string
  let pool: ExtractionPool | null

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pool-'))
    pool = null
  })

  afterEach(async () => {
    if (pool) await pool.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('extracts text from a real markdown file end-to-end', async () => {
    const filePath = path.join(dir, 'note.md')
    fs.writeFileSync(filePath, '# Hello\n\nworker pool works')
    pool = createExtractionPool({ size: 1 })
    const result = await pool.extract(filePath, { runImageOcr: false })
    expect(result.text?.success).toBe(true)
    expect(result.text?.content).toContain('worker pool works')
    expect(result.image).toBeNull()
    expect(result.ocr).toBeNull()
  })

  it('handles 50 concurrent jobs without losing any', async () => {
    const paths: string[] = []
    for (let i = 0; i < 50; i++) {
      const p = path.join(dir, `n-${i}.md`)
      fs.writeFileSync(p, `marker-${i} content`)
      paths.push(p)
    }
    pool = createExtractionPool({ size: 2, maxQueueLength: 100 })
    const results = await Promise.all(paths.map(p => pool!.extract(p, { runImageOcr: false })))
    expect(results.length).toBe(50)
    for (let i = 0; i < 50; i++) {
      expect(results[i].text?.content, `result for n-${i} missing marker`).toContain(`marker-${i}`)
    }
  })

  it('size-1 pool serializes work correctly (degenerate case)', async () => {
    // Per Slice 3 plan Task 2: 2-core CI boxes give size 1 from the
    // helper. Single worker means no parallelism — must still produce
    // correct results, just sequentially.
    const paths: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `s-${i}.md`)
      fs.writeFileSync(p, `single-${i}`)
      paths.push(p)
    }
    // size: 1 → default maxQueueLength = 4. Submitting 5 in parallel
    // would hit the cap (1 in flight + 4 queued = 5th rejected). Bump
    // the cap to keep this test focused on serialization, not backpressure.
    pool = createExtractionPool({ size: 1, maxQueueLength: 10 })
    const results = await Promise.all(paths.map(p => pool!.extract(p, { runImageOcr: false })))
    for (let i = 0; i < 5; i++) {
      expect(results[i].text?.content).toContain(`single-${i}`)
    }
  })

  it('close() awaits in-flight jobs and rejects new submissions with EXTRACTION_POOL_CLOSED', async () => {
    const filePath = path.join(dir, 'inflight.md')
    fs.writeFileSync(filePath, 'inflight body')
    pool = createExtractionPool({ size: 1 })

    // Fire one job, immediately close — close() must wait for it to land.
    const inflight = pool.extract(filePath, { runImageOcr: false })
    const closed = pool.close()
    const result = await inflight
    expect(result.text?.content).toContain('inflight body')
    await closed

    // After close, new extract() calls reject with the typed error.
    await expect(pool.extract(filePath, { runImageOcr: false }))
      .rejects.toBeInstanceOf(ExtractionPoolClosedError)

    pool = null  // already closed
  })

  it('rejects with EXTRACTION_QUEUE_FULL when queue exceeds maxQueueLength', async () => {
    const filePath = path.join(dir, 'q.md')
    fs.writeFileSync(filePath, 'queue test')
    // Tiny cap so we can exhaust deterministically. size: 1, maxQueueLength: 1.
    // Submit 3 jobs in the same tick — first goes to the worker, second
    // queues, third hits the cap.
    pool = createExtractionPool({ size: 1, maxQueueLength: 1 })
    const a = pool.extract(filePath, { runImageOcr: false })
    const b = pool.extract(filePath, { runImageOcr: false })
    const c = pool.extract(filePath, { runImageOcr: false })
    await expect(c).rejects.toBeInstanceOf(ExtractionQueueFullError)
    // a + b still resolve cleanly.
    await expect(a).resolves.toBeDefined()
    await expect(b).resolves.toBeDefined()
  })

  it('throws on invalid pool size', () => {
    expect(() => createExtractionPool({ size: 0 })).toThrow(/size must be >= 1/)
  })
})
