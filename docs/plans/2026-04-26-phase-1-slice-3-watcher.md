# Phase 1 Slice 3: Watcher + Worker-Pool Extraction (real-time indexing)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` discipline for every task: write the failing test first, then the minimal code, then commit. Each task is its own commit on the `phase-1-slice-3` branch (to be created). Open the PR at the end of the final task. Per `feedback_pr_workflow`: this is major work — direct push to `main` is forbidden.

**Goal:** Make the daemon update its index within **5 seconds** of any file mutation in the user's scan roots, without blocking other RPCs. F-009's follow-up (extraction outside the DB transaction, worker-pool extractors) lands here. F-011 (delete/rename detection) closes here via watcher events instead of scan-time diff.

This is the slice that turns `mmd` from "a long-lived process serving an index that goes stale between manual `mm scan` runs" into "a long-lived process whose index actually keeps up with the filesystem." Phase 1's ship bar from `docs/23` §10 — *"agent can call `mm_find`; live-index within 5s"* — is closed by this slice.

## Architecture

The Slice 1 daemon (`mmd`) and the Slice 2 MCP surface stay exactly as they are — neither the Unix-socket protocol nor the MCP transports change. On top of that, three new internal subsystems land:

```
                  ┌──────────────────────────────────────────────────┐
                  │                       mmd                        │
                  │                                                  │
   filesystem ──> │  watcher  ──>  debounce queue  ──>  worker pool  │
                  │  (chokidar)    (per-path)         (worker_threads)│
                  │                                       │          │
                  │                                       ▼          │
                  │                          writer queue (main)     │
                  │                                       │          │
                  │                                       ▼          │
                  │                                  SQLite (WAL)    │
                  └──────────────────────────────────────────────────┘
```

- **Watcher** (`src/daemon/watcher.ts`). One `chokidar.watch(roots, …)` instance per daemon process, configured with the same `DEFAULT_EXCLUDE_GLOBS` the scanner uses (translated to chokidar v4+'s `ignored` predicate form, since v4 removed glob support — see Reference docs below). `awaitWriteFinish` enabled so a 200 MB PDF copied in chunks does not produce a half-extracted blob. Events: `add`, `change`, `unlink`, `addDir`, `unlinkDir`, `error`, `ready`.

- **Debounce queue** (`src/daemon/watcherQueue.ts`). Per-path coalescer. If `change` fires three times for the same path inside 250 ms (an editor save burst), only one extraction job lands on the worker pool. Implemented as a `Map<string, Timeout>` plus a `Set<string>` of paths in flight. Eviction policy: latest event wins (drop earlier coalesced events of the same kind for the same path; an `unlink` cancels a pending `change`).

- **Worker pool** (`src/daemon/extractionPool.ts`). `node:worker_threads`, pool sized `min(4, cpuCount - 1)` per `docs/23` §3. Workers run `extractTextFromFileResult`, `extractImageMetadata`, `extractImageOcr` — the same three extractor entry points the scanner uses today, hoisted into a worker-thread context. Workers return structured results to the main thread; the main thread owns SQLite (better-sqlite3 is synchronous and not safe to share across threads, so single-writer is the only correct shape).

- **Writer queue** (added to `src/daemon/serverCore.ts`'s long-running state). FIFO of pending `{path, fileRow, textBlobs[]}` results. Drained by a single async loop that opens a `db.transaction(...)` per drain pass (one transaction per drain, NOT per file) and runs the upserts. Drain runs on demand whenever the queue goes from empty to non-empty, plus a 50 ms tick to amortize bursts.

The **F-009 follow-up** (extraction outside the SQLite transaction) is the load-bearing change. Today's `scanFiles` wraps a `db.transaction(...)` around `processFile`, and `processFile` calls `extractTextFromFileResult` synchronously — meaning a 30-second PDF extraction holds the SQLite writer transaction for 30 seconds. With a watcher firing while a scan is in progress, the writer would block and the daemon's RPC handlers would queue. Lifting extraction outside the transaction — and pushing it onto worker threads — is what makes the daemon stay responsive (`_ping` < 50 ms) while indexing 100 mutations/sec.

The watcher pipeline and `mm scan` (cold-start full scan) share the worker pool and the writer queue. `mm scan` becomes a *bootstrap* path that primes the index; the watcher keeps it warm. Both go through the same final SQL.

## Tech stack

- **`chokidar@^5`** (current latest is `5.0.0` per `npm view chokidar version` 2026-04-26). Critical v4+ change vs. v3: glob support removed; `ignored` is now a function `(path, stats) => boolean` or a `Matcher` array. Our existing `DEFAULT_EXCLUDE_GLOBS` are still glob strings; we either pre-expand them or pass them through `picomatch` (which chokidar already uses internally). Recommend converting once in `watcher.ts` via `picomatch.compose(globs)` to avoid per-event regex work.
- **`node:worker_threads`** (built-in). No third-party pool library needed — Node's primitives are sufficient for this scale. A 60-line round-robin pool with a job queue and a `Worker.postMessage`/`message` round-trip is enough.
- **`node:perf_hooks`** for the responsiveness assertion in tests (`performance.now()` for `_ping` latency under load).
- **`better-sqlite3`** (existing). No version change. Continues to be the only SQLite writer; workers do not import it.
- **`vitest`** (existing) for tests.

## Reference docs read before writing this plan

- `docs/23-product-v2-architecture.md` §3 (Architecture diagram showing watcher → activity events → indexers), §7.2 Phase 1 plan (watcher + F-009 follow-up bullet), §10 (Phase 1 ship bar — "live-index within 5s")
- `docs/22-phase-2-research.md` §4 (rename detection algorithm — sha256-based pairing of unlink+add), §5 (inotify vs fanotify — confirms inotify with aggressive excludes is the v1 call), §6 (watcher MUST enqueue into the same pipeline as the scanner, not write directly)
- `docs/13-decision-log.md` D-017 (file-record fingerprint vs extraction state — we honor this), F-009 follow-up note at line 207
- `docs/15-current-state.md` §"Performance and concurrency" (the existing batch-commit + WAL story, which we extend rather than replace)
- `docs/19-phase-1-validation.md` "F-007 Resolved" + "Phase 1 Reopen" sections (the perf baseline this slice cannot regress)
- `docs/plans/2026-04-21-phase-1-slice-2-mcp.md` (slice-shape and TDD discipline reused here)
- chokidar README via context7 (`/paulmillr/chokidar`) — v4+ API, `awaitWriteFinish`, `ignored`-as-function, the absence of a `rename` event (chokidar emits unlink+add; we pair them in our own code)

## Ship bar (slice acceptance)

Each item below has a concrete check. The slice is not done until every item has evidence in `docs/29-phase-1-slice-3-validation.md` (parallel to the Slice 1 and Slice 2 validation docs).

1. **Liveness within 5 s.** Touch a file under a real scan root, e.g. `echo "hello slice 3" >> ~/projects/scratch.md`. Within 5 seconds, `mm find "slice 3"` returns the file. Reproduced manually three times against the daemon running on the contributor's machine, captured with timestamps in the validation doc.

2. **Daemon stays responsive under load.** While 100 file mutations/sec are flowing through the watcher (a test that writes 100 small files in 1 s, then waits a beat, then writes 100 more), `_ping` p95 latency stays under 50 ms. Test fails the slice if p95 ≥ 50 ms.

3. **F-009 closed.** A test asserts that `extractTextFromFileResult` (or any extractor) never runs while a SQLite write transaction is held. Implemented by spying on `db.transaction()`'s callback boundary — the call stack inside the transaction must not contain `extractTextFromFileResult`.

4. **F-011 closed.** Renaming a file (`mv ~/projects/a.md ~/projects/b.md`) updates the existing record's path instead of creating a ghost row. Deleting a file removes the record AND its text blobs. Both verified end-to-end through `mm find` and direct DB queries.

5. **Slice 1 + 2 still pass.** All 100 existing tests continue to pass. Daemon `mm daemon start/stop/status`, `mm find`/`mm show`, and both MCP transports (stdio + HTTP) survive every change in this slice.

6. **Build hygiene.** `npm run typecheck` clean, `npm run build` clean, `npm test` 100 % green on a fresh `npm ci`.

## Out of scope (do not creep — name what's deferred)

- **`mm_subscribe` MCP tool implementation.** This slice ships the *internal* event source (the watcher) and an in-process event emitter. The MCP tool that lets agents subscribe to events lives in **Phase 4** (conversational layer). A separate design doc — `docs/28-mm-subscribe-design.md` — is written here to lock the streaming surface, but no `registerTool('mm_subscribe', …)` call lands.
- **Activity events table (`activity_events`).** Phase 2. The watcher's events stay in-memory in this slice. Phase 2's first ingester reuses the watcher event stream as its source.
- **Soft-delete via tombstone (`metadata_json.deletedAt`).** Phase 2. Slice 3 hard-deletes file records on `unlink` because there is no activity table yet that would benefit from the tombstone. Documented as a known choice in the validation doc.
- **macOS launchd port and `fsevents`-specific handling.** Slice 5. We *will* import chokidar (which uses fsevents on macOS automatically) but we will not test or claim macOS support.
- **Performance benchmarks at 100k / 500k file scale.** Slice 5. Slice 3's stress test is the 100-mutations/sec responsiveness check — enough to prove the architecture, not enough to claim production scale.
- **`fs.inotify.max_user_watches` sysctl tuning.** Documented in the slice's validation doc as a known operator-side configuration; the installer (Slice 4) is the right place to detect-and-suggest this, not Slice 3.
- **F-014 — ephemeral MCP HTTP port runbook.** Slice 4 (installer's responsibility).
- **Filtering and projection on `mm_find`.** Slice 2's `query`-only schema stays as-is; `kinds`/`path_prefix`/`since`/`limit` are a future MCP enhancement.

## Pre-slice work (small, separable)

These are not Slice 3 itself but should land before or with Slice 3 to avoid contamination:

- **Open follow-up #1: `tests/unit/daemon/cliCommand.test.ts > detached start errors when serverScript is missing` is build-order-dependent.** The test creates a stub `src/daemon/server.js` in a `try/finally`, and a previous run that crashed before `finally` leaves the stub on disk and breaks the next run's "errors when missing" assertion. The fix is a tiny pre-test cleanup block. **Recommendation:** ship as a tiny PR (one commit, no scope expansion) BEFORE this slice's branch is created, so Slice 3 starts from a clean test floor. Title: `test(daemon): pre-clean leftover server.js stub before missing-script assertion`.

- **F-015 — transport-parity property test.** Slice 2's validation manually diffed `mm_find` / `mm_get` output between stdio and HTTP. A property test that fuzzes inputs and asserts byte-equal `structuredContent` between transports closes the manual loop. **Recommendation:** land as Task 8 of this slice (sibling test enhancement) — the watcher does not interact with transport plumbing, but Slice 3 is the natural moment to add it before more MCP surface accumulates.

---

## Task 1: Lift extraction outside the SQLite transaction (`scanFiles` refactor)

**Why:** F-009's follow-up #1. Today `processBatch = db.transaction(batch => batch.forEach(processFile))` and `processFile` synchronously calls `extractTextFromFileResult`. A 30-second PDF extraction holds the writer transaction for 30 seconds, blocking every other writer including the watcher's incoming events. This task does the structural refactor in the *cold-start* `scanFiles` path *first*, with no behavior change visible to callers, so the worker pool task (Task 2) and the watcher task (Task 4) can plug into a clean shape. Doing this in cold-start first is deliberate: the existing scan tests give us regression coverage for free, and the watcher arrives onto an already-corrected pipeline.

**Files:**
- Modify: `src/scanner/fileScanner.ts` (the main refactor)
- Modify: `tests/unit/scanFiles.test.ts` (regression assertion that the transaction is small)
- Modify: `tests/unit/scanCommand.test.ts` if it asserts on transaction shape

**Step 1: Write the failing test.** Add a test that spies on `db.transaction` (or on `db.prepare`'s `run` calls) and asserts that during a scan, no extraction function is invoked while a transaction callback is on the stack. The cleanest approach is to mock `extractTextFromFileResult` to record the call timestamp and to record every `db.transaction()` callback's open/close timestamps; assert no overlap.

**Step 2: Run test, confirm it fails.** Today's code overlaps; the test should fail by reporting an extraction call timestamp inside a transaction window.

**Step 3: Refactor `scanFiles`.** Two-pass per batch:
1. **Pass A (no DB transaction):** for each file in the batch, run `safeStat`, fingerprint check, and any extractor work. Collect a `BatchResult[]` of `{filePath, fingerprintMatched, fileRow, textBlobs, imageMetadata}` in memory.
2. **Pass B (one DB transaction per batch):** apply `BatchResult[]` — `insert.run(fileRow)` and `upsertTextBlob` for each blob.

Pass A is what the watcher will reuse later; Pass B is what the writer queue will reuse.

**Step 4: Re-run tests.** All 18 existing scan tests still pass; the new transaction-isolation test passes.

**Commit message:** `refactor(scanner): hoist extraction outside the per-batch sqlite transaction (F-009 follow-up #1)`

---

## Task 2: Worker-thread extraction pool

**Why:** F-009's follow-up #2. Even outside the transaction, extraction on the main thread blocks the daemon's RPC handlers because better-sqlite3 is synchronous and the event loop is single-threaded. Moving extractors to worker threads keeps `_ping` responsive while CPU-bound extraction runs.

**Files:**
- Create: `src/daemon/extractionPool.ts`
- Create: `src/daemon/extractionWorker.ts` (the worker entry)
- Modify: `src/scanner/fileScanner.ts` (Pass A delegates to the pool when a pool is provided; falls back to in-thread extraction when not, so `mm scan` from the CLI without a daemon still works)
- New: `tests/unit/daemon/extractionPool.test.ts`

**Step 1: Pool API.** Single export:

```
createExtractionPool({ size: number }): ExtractionPool

interface ExtractionPool {
  extract(filePath: string, options: ExtractionOptions): Promise<ExtractionResult>
  close(): Promise<void>
}
```

`ExtractionResult` is the same shape `processFile` already builds in memory — text blobs + image metadata. The pool is a round-robin dispatcher over `size` workers; each worker handles one job at a time. Backpressure: if all workers are busy, `extract()` queues with a max-queue-length cap (proposed: 4× `size`; jobs over the cap reject with `EXTRACTION_QUEUE_FULL`).

**Step 2: Worker entry.** `extractionWorker.ts` listens on `parentPort` for `{path, options}` messages, runs the three extractor entry points, and posts back the result. Workers do NOT import `better-sqlite3`. They DO import `extractTextFromFileResult`, `extractImageMetadata`, `extractImageOcr` — the existing pure functions.

**Step 3: Pool tests.** Cover: pool extracts a real markdown file end-to-end; pool handles 50 concurrent jobs without losing any; pool's `close()` settles in-flight jobs and rejects new ones; pool size <= cpuCount-1 (the helper that picks the size is exported and unit-tested separately).

**Step 4: `scanFiles` integration.** Add an optional `pool?: ExtractionPool` to `FileScanOptions`. Pass A uses the pool if present (await all extract calls in parallel, bounded by pool size); otherwise falls back to in-thread extraction (so the bare `mm scan` CLI path keeps working without spawning workers).

**Commit message:** `feat(daemon): worker-thread extraction pool (F-009 follow-up #2)`

---

## Task 3: Chokidar watcher module

**Why:** The event source. Slice 3 cannot ship without it; everything else hangs off this.

**Files:**
- Create: `src/daemon/watcher.ts`
- Create: `tests/integration/daemonWatcher.test.ts`

**Step 1: Module shape.**

```
createWatcher({ roots, ignored, onEvent }): WatcherHandle

interface WatcherHandle {
  close(): Promise<void>
  ready: Promise<void>          // resolves when initial scan completes
}

type WatcherEvent =
  | { kind: 'add', path: string, stats: fs.Stats }
  | { kind: 'change', path: string, stats: fs.Stats }
  | { kind: 'unlink', path: string }
  | { kind: 'error', error: Error }
```

The module is a thin wrapper around `chokidar.watch(roots, opts)` that translates chokidar's events into our `WatcherEvent` union and calls `onEvent`. `addDir` / `unlinkDir` are observed but not emitted upward — the watcher acts at file granularity.

**Step 2: Configuration.**
- `ignored`: derived from `DEFAULT_EXCLUDE_GLOBS` via `picomatch` (chokidar v4+ takes a function or matcher array, NOT glob strings — confirmed via context7). Convert once at watcher startup.
- `awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }`. 500 ms is enough for editor saves; large PDF copies will simply emit later. Justified in a code comment.
- `persistent: true`, `ignoreInitial: true`. The initial scan is `mm scan`'s job; the watcher only watches forward.
- `alwaysStat: true` so `add`/`change` carry a `Stats` object — we need `mtime` and `size` for fingerprinting.

**Step 3: Test.** Spin up the watcher on a `mkdtemp` directory; create, modify, delete a file; assert the right events arrive in the right order with correct paths. Use `awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 }` in tests so they finish in under a second.

**Commit message:** `feat(daemon): chokidar watcher with awaitWriteFinish and predicate-based ignores`

---

## Task 4: Debounce queue + writer-queue glue

**Why:** A single editor save can fire 3-5 chokidar events for the same path within a few hundred ms (vim's swap file dance, atomic rename pattern, multi-step writers). Without coalescing, we'd extract the same file 3-5 times.

**Files:**
- Create: `src/daemon/watcherQueue.ts`
- Create: `tests/unit/daemon/watcherQueue.test.ts`
- Modify: `src/daemon/serverCore.ts` (mount the watcher + queue + pool when the daemon starts; tear them down on `close()`)

**Step 1: Queue semantics.** Per-path debounce: when an event arrives for path P, schedule a job for P at `now + debounceMs`. If another event for P arrives before the timer fires, push the deadline back. Cap: a single path cannot be re-debounced indefinitely — if its first event was more than `maxDelayMs` ago, force the job through. Proposed defaults: `debounceMs = 250`, `maxDelayMs = 2000`.

**Step 2: Event collapsing.** If the *latest* event for path P is `unlink`, cancel any pending extraction for P and emit only the unlink. If the latest is `add` or `change`, emit one job for the latest event.

**Step 3: Writer queue.** Single-consumer FIFO drained on the daemon main thread. Each drain pass opens a `db.transaction(...)` and applies all in-flight `BatchResult`s. Drain triggers: queue length goes from 0 to >0, or every 50 ms (safety tick). The writer queue cap is generous (proposed: 10000 entries) — if hit, log a warning and start dropping oldest extraction results (a future scan rescue covers them).

**Step 4: Integration test.** Touch the same file 5 times in 100 ms; assert exactly one extraction is invoked and one DB upsert happens.

**Commit message:** `feat(daemon): per-path debounce queue and writer queue draining`

---

## Task 5: Wire watcher → pool → writer (the live path)

**Why:** Glue task that activates the pipeline.

**Files:**
- Modify: `src/daemon/serverCore.ts` (the `createServer(opts)` factory now also constructs `extractionPool`, `watcher`, and `writerQueue`; `close()` tears them down in reverse order)
- Modify: `src/config/types.ts` if needed for `MM_SCAN_ROOTS` / config plumbing
- New: `tests/integration/daemonLivePath.test.ts`

**Step 1: Roots resolution.** Use the same `getDefaultScanRoots()` the CLI uses, OR accept an explicit `roots` option for tests. Document the precedence in a code comment: `opts.roots > MM_SCAN_ROOTS env > getDefaultScanRoots()`.

**Step 2: Startup ordering.** `createServer` must:
1. Open DB.
2. Bind unix socket.
3. Write pid file.
4. Start MCP HTTP listener (Slice 2's existing path).
5. Construct extraction pool.
6. Construct writer queue.
7. Start watcher; await `watcher.ready`.

Failure at any step still tears down everything in reverse via `teardownPartial` (extend Slice 1's existing helper).

**Step 3: End-to-end test.** Start the daemon on a `mkdtemp` root with no files. Touch `root/note.md`. Within 2 seconds, `mm_find {query: 'note'}` (over the daemon's internal call path, no MCP) returns the file. Use real timers, real chokidar, real DB. This test is the slice's center of gravity — if it fails, the slice is not done.

**Commit message:** `feat(daemon): wire watcher → extraction pool → writer queue end-to-end`

---

## Task 6: Delete + rename via watcher events (closes F-011)

**Why:** Today `unlink` from chokidar would only remove the file row if we wrote that handler. Today's code does not. Renames in chokidar appear as `unlink(old) + add(new)` — pairing them by sha256 (per `docs/22` §4) avoids the ghost-row problem.

**Files:**
- Modify: `src/daemon/watcherQueue.ts` (rename pairing logic)
- Modify: `src/index/db.ts` schema if a `sha256` column is missing on `file_records` (per `docs/22` §4 step 1; check current schema before assuming)
- Modify: writer queue's apply-batch to handle delete + rename
- New tests for both operations

**Step 1: Sha256 column check.** Read `src/index/schema.ts`. If `file_records.sha256` already exists, skip; otherwise add it as a non-NOT-NULL column with a follow-up backfill marked as out-of-scope-for-this-task (scanner backfills it on next pass).

**Step 2: Rename pairing.** When an `unlink(P)` arrives, mark the row for P as "pending deletion" with a 1-second grace. If an `add(Q)` arrives within the grace AND the new file's sha256 matches the deleted row's sha256, treat it as a rename: update the row's `path` to Q, cancel the deletion. If the grace expires with no match, hard-delete the row + text blobs.

**Step 3: Tests.** `mv a.md b.md` updates the existing row, no ghost. `rm a.md` removes the row + text blobs. Concurrent moves of multiple files (renaming three files in 100ms) all match correctly.

**Commit message:** `feat(daemon): handle unlink and rename via watcher events (closes F-011)`

---

## Task 7: Stress test for daemon responsiveness under watcher load

**Why:** Ship-bar item #2. Without a deterministic test, we can ship a daemon that "feels fine in dev" but stalls on a real workload.

**Files:**
- New: `tests/integration/daemonResponsivenessUnderLoad.test.ts`

**Step 1: Test design.**
1. Start the daemon on a tmp root.
2. Spawn a producer that writes 100 small markdown files into the root in 1 second.
3. Concurrently, fire `_ping` over the unix socket every 20 ms for 5 seconds. Record latencies.
4. Repeat the producer (another burst of 100 files).
5. Assert `_ping` p95 < 50 ms across all measurements.

**Step 2: Run, tune.** If the test is flaky on slow CI, raise the threshold rather than weaken the assertion — but the threshold itself is the ship-bar contract. If we cannot hit p95 < 50 ms at 100 mutations/sec, the architecture is wrong and we owe a re-design before shipping.

**Commit message:** `test(daemon): assert _ping p95 < 50ms while watcher ingests 100 mutations/sec`

---

## Task 8: F-015 — transport-parity property test (sibling)

**Why:** Closes the manual `mm_find`/`mm_get` byte-equality check from `docs/25-phase-1-slice-2-validation.md`. Lands in this slice because the watcher-driven index gives us a richer corpus of test inputs (random-but-deterministic file content, varied paths) and because no one will write this once Slice 3 closes if we don't write it now.

**Files:**
- New: `tests/integration/transportParity.test.ts`

**Step 1: Property generator.** `fast-check`-style (or hand-rolled with `seedrandom`): generate N random `query` strings drawn from the words in the test corpus. For each, call `mm_find` once via stdio and once via HTTP, assert `structuredContent` is byte-equal. 50 iterations is sufficient at this stage.

**Step 2: Same shape for `mm_get` and `mm_recent`.** Cover all three tools.

**Commit message:** `test(mcp): property test asserting stdio/http transport byte-parity for mm_find/mm_get/mm_recent`

---

## Task 9: `mm_subscribe` design doc (no implementation)

**Why:** Locks the streaming-MCP-tool surface NOW so Phase 4's implementer is not re-deriving it from scratch under deadline pressure. A separate doc keeps Slice 3's plan focused.

**Files:**
- New: `docs/28-mm-subscribe-design.md`

**Step 1: Contents (outline).**
1. **Motivation.** Polling `mm_recent` is wasteful for an agent that wants to react to file events.
2. **Tool surface.** Input schema (`path_prefix?`, `kinds?: ('file_modified' | 'file_added' | 'file_deleted')[]`, `since?: ISODateTime`). Output: streaming MCP tool result, one event per chunk.
3. **Backpressure.** SDK's `StreamableHTTPServerTransport` already supports streaming responses; document the chunking model.
4. **Transport applicability.** HTTP transport: yes (streamable). Stdio transport: yes (one notification per event). Both transports route through the same daemon-side event emitter.
5. **Lifecycle.** What happens when the client disconnects mid-stream; whether stale subscriptions are GC'd.
6. **What this slice ships vs. what Phase 4 ships.** Slice 3 = internal in-process emitter; Phase 4 = MCP tool registration + per-client subscription state.

No code in this task — pure design.

**Commit message:** `docs: lock the mm_subscribe streaming MCP surface for Phase 4`

---

## Task 10: Validate against the real machine

**Why:** Phase 1 is graded against real local content (per D-016). Slice 1 and Slice 2 each shipped a validation doc; Slice 3 owes one too.

**Files:**
- New: `docs/29-phase-1-slice-3-validation.md`

**Step 1: Run the live-path scenario on the contributor's actual machine.**
- Start `mmd` on the real `getDefaultScanRoots()`.
- `echo "slice 3 watcher proof" >> ~/projects/scratch.md` (or whatever real path is convenient).
- Time how long it takes `mm find "slice 3 watcher"` to return the file.
- Repeat with: a rename, a delete, a screenshot saved into `~/Desktop`, a markdown edit in `~/projects/...`.
- Capture timestamps, observed events from `MM_TRACE=1`, and the resulting DB state.

**Step 2: Run the stress test on the real machine** (Task 7's harness). Capture `_ping` latencies on the contributor's actual hardware.

**Step 3: Document `inotify.max_user_watches` posture.** Run `cat /proc/sys/fs/inotify/max_user_watches`; if below 524288, document the recommended sysctl override and note that Slice 4's installer should detect-and-suggest it.

**Step 4: Document one known false negative.** Pick the most plausible case our chokidar config will miss (proposed candidate: a file written via `mmap` without a `close(2)` — chokidar will eventually emit on inactivity, but the 5-second bar may slip). Record honestly.

**Commit message:** `docs: validate Slice 3 watcher pipeline against the real machine`

---

## Task 11: Open the PR

**Why:** Major work goes through PR per `feedback_pr_workflow`.

**Files:** None.

**Step 1: Push the branch.**
```
git push -u origin phase-1-slice-3
```

**Step 2: Open the PR with the standard template.** Title: `Phase 1 Slice 3: watcher + worker-pool extraction`. Body summarizes what shipped + the validation evidence pointer. Test plan checks: Slice 1 + 2 still pass, ship-bar items 1–6 each cite the doc/test that proves them.

**Step 3: Wait for review.** Two surfaces per `reference_pr_review_surfaces.md`: an external human reviewer and CodeRabbit. Address any High findings before merging.

---

## Risk register (from `docs/27-gotchas-and-honest-risks.md`)

- **G-1 (agent adoption):** Slice 3 makes `mm_find` *useful* (fresh index) but does not make agents reach for it. Adoption is still G-1's problem; this slice removes one excuse ("the index is stale, why bother") without solving the bigger one.
- **G-4 (semantic retrieval limbo):** Unaffected. Slice 3 is lexical only.
- **A-1 (single-user trap):** Slice 3 is tested only on the contributor's machine. Acceptable for shipping but flag in the validation doc that the watcher has not been observed on a second user's tree.
- **Inotify watch limit:** Documented in Task 10 §3. The risk is that a user with many small files in `~/projects` (a monorepo of monorepos) hits the default 8192 limit and silently broken indexing follows. Slice 4's installer will detect-and-warn; Slice 3 will not.
- **awaitWriteFinish 500 ms tax:** Adds 500 ms of latency to every "small file" event because chokidar polls for stability before emitting. That eats into our 5-second ship bar — leaving 4.5 seconds for queueing + extraction + write. If extraction takes ≥ 4 seconds (a large PDF), we slip the bar. Recorded as a known trade-off; the ship-bar test uses small markdown files where the budget is generous.

## Open questions to resolve during execution (not blockers)

- Should the writer queue's drain interval (50 ms) be tunable? Probably yes via `MM_WRITER_DRAIN_MS=…` for power-user debugging. Ship the env knob undocumented in this slice; promote to docs only if someone asks.
- Should `mm_subscribe`'s design doc include an example `since`-based replay strategy? The internal event emitter doesn't persist events; replay across daemon restarts is not on the table without the activity-events table. Note in the design doc as Phase-4-or-later.
- Does the worker pool need a graceful "drain in flight" mode for daemon shutdown? `close()` should `await` in-flight jobs before terminating workers; new jobs reject. Implement in Task 2 and document.
