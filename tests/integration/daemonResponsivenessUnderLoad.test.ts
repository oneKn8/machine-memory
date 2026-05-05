import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type DaemonServer } from '../../src/daemon/serverCore.js'
import { call as daemonCall } from '../../src/daemon/client.js'

// Slice 3 Task 7 — ship-bar item #2.
//
// While 100 file mutations/sec are flowing through the watcher, _ping
// p95 latency stays under 50 ms AND p100 (max single ping) under 500 ms.
// The p100 bound is the new addition from plan revision: p95 alone
// allows 1-in-20 pings to be arbitrarily slow — exactly the signal an
// agent uses to mark the daemon dead, so the bound is necessary.
//
// If we cannot hit these on a 4-core dev box, the architecture is
// wrong and we owe a re-design before shipping. On smaller runners
// (size-1 worker pool degenerate case from defaultExtractionPoolSize),
// the test is skipped rather than weakened.

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

describe('mmd responsiveness under watcher load (Slice 3 Task 7)', () => {
  let dir: string
  let watchRoot: string
  let daemon: DaemonServer | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stress-'))
    process.env.MM_DATA_DIR = dir
    watchRoot = path.join(dir, 'roots')
    fs.mkdirSync(watchRoot, { recursive: true })

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

  it('keeps _ping p95 < 50 ms AND p100 < 500 ms while ingesting ~100 mutations/sec', async () => {
    const cpus = os.availableParallelism()
    if (cpus < 3) {
      // Plan: 2-core CI may legitimately hit p100 spikes from worker-
      // pool degeneracy (size 1 = no parallelism). Skip rather than
      // weaken the bound.
      return
    }

    // Wall-clock CPU probe: availableParallelism() reflects sched-
    // affinity but not cgroup CPU quotas (containers with --cpus=1
    // on a 16-core host still report 16). Spin a tight loop for 50ms;
    // if iteration count is far below a healthy laptop's baseline,
    // the host is effectively CPU-throttled and the latency assertion
    // would be meaningless. Skip.
    {
      const probeStart = performance.now()
      let n = 0
      while (performance.now() - probeStart < 50) n++
      if (n < 1_000_000) return
    }

    // Producer: write 200 small markdown files across two bursts, with
    // a brief inter-burst pause. Each file is small so the extractor is
    // fast — the load is queue/scheduling pressure, not extraction CPU.
    const producerStart = performance.now()
    const producer = (async () => {
      for (let burst = 0; burst < 2; burst++) {
        for (let i = 0; i < 100; i++) {
          const idx = burst * 100 + i
          fs.writeFileSync(path.join(watchRoot, `f-${idx}.md`), `mutation ${idx} marker`)
          await new Promise(r => setTimeout(r, 10))
        }
        await new Promise(r => setTimeout(r, 200))
      }
    })()

    // Pinger: fire _ping every 20 ms for 5 seconds, recording latency.
    const latencies: number[] = []
    const pingDeadline = Date.now() + 5000
    const pinger = (async () => {
      while (Date.now() < pingDeadline) {
        const start = performance.now()
        try {
          await daemonCall(daemon!.socketPath, '_ping', {})
        } catch {
          // A failed ping IS a responsiveness failure — count it as a
          // very-slow ping rather than dropping it from the sample.
          // Sleep before continuing so a sustained failure doesn't
          // flood `latencies` and skew percentiles.
          latencies.push(10000)
          await new Promise(r => setTimeout(r, 20))
          continue
        }
        latencies.push(performance.now() - start)
        await new Promise(r => setTimeout(r, 20))
      }
    })()

    await Promise.all([producer, pinger])
    const elapsedSec = (performance.now() - producerStart) / 1000
    const actualRate = 200 / elapsedSec

    // Compute statistics.
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)
    const p100 = sorted[sorted.length - 1] ?? 0

    const summary = `latencies: n=${sorted.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms p100=${p100.toFixed(2)}ms; producer=${actualRate.toFixed(1)}/s`

    // Verify the test exercised the load it claims to. A test that
    // silently weakens its own load is worse than no test — without
    // this check, a slow runner might "pass" the latency assertion
    // simply because it never approached 100/s.
    expect(actualRate, `producer rate too low to validate the bound (${summary})`).toBeGreaterThan(60)
    expect(sorted.length, 'pinger collected too few samples').toBeGreaterThan(50)
    expect(p95, `p95 must be < 50ms (${summary})`).toBeLessThan(50)
    expect(p100, `p100 must be < 500ms (${summary})`).toBeLessThan(500)
  }, 30000)
})
