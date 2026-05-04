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

- **Watcher** (`src/daemon/watcher.ts`). One `chokidar.watch(roots, …)` instance per daemon process, configured with the same `DEFAULT_EXCLUDE_GLOBS` the scanner uses (translated to chokidar v4+'s `ignored` predicate form — we use v5; v4+ removed glob support — see Reference docs below). `awaitWriteFinish` enabled so a 200 MB PDF copied in chunks does not produce a half-extracted blob; tuned per file-size bucket (Task 3). Events: `add`, `change`, `unlink`, `addDir`, `unlinkDir`, `error`, `ready`. `followSymlinks: false` to avoid loop blow-ups on `node_modules`-style symlink farms.

- **Debounce queue** (`src/daemon/watcherQueue.ts`). Per-path coalescer. If `change` fires three times for the same path inside 250 ms (an editor save burst), only one extraction job lands on the worker pool. Implemented as a `Map<string, Timeout>` plus a `Set<string>` of paths in flight. Eviction policy: latest event wins (drop earlier coalesced events of the same kind for the same path; an `unlink` cancels a pending `change`).

- **Worker pool** (`src/daemon/extractionPool.ts`). `node:worker_threads`, pool sized `min(4, cpuCount - 1)` per `docs/23` §3. Workers run `extractTextFromFileResult`, `extractImageMetadata`, `extractImageOcr` — the same three extractor entry points the scanner uses today, hoisted into a worker-thread context. Workers return structured results to the main thread; the main thread owns SQLite (better-sqlite3 is synchronous and not safe to share across threads, so single-writer is the only correct shape).

- **Writer queue** (added to `src/daemon/serverCore.ts`'s long-running state). FIFO of pending `{path, fileRow, textBlobs[]}` results. Drained by a single async loop that opens a `db.transaction(...)` per drain pass (one transaction per drain, NOT per file) and runs the upserts. Drain runs on demand whenever the queue goes from empty to non-empty, plus a 50 ms tick to amortize bursts.

The **F-009 follow-up** (extraction outside the SQLite transaction) is the load-bearing change. Today's `scanFiles` wraps a `db.transaction(...)` around `processFile`, and `processFile` calls `extractTextFromFileResult` synchronously — meaning a 30-second PDF extraction holds the SQLite writer transaction for 30 seconds. With a watcher firing while a scan is in progress, the writer would block and the daemon's RPC handlers would queue. Lifting extraction outside the transaction — and pushing it onto worker threads — is what makes the daemon stay responsive (`_ping` < 50 ms) while indexing 100 mutations/sec.

**`mm scan` and the daemon writer queue stay separated in this slice.** `mm scan` continues to run as a CLI subcommand that opens its own DB connection (today's behavior). It is unchanged here except for the Task 1 refactor that hoists extraction outside the per-batch transaction. Routing `mm scan` *through* the daemon's writer queue is a Phase 2 concern (it requires the writer queue to expose an RPC and to merge-on-conflict with watcher events for the same path) — calling it out of scope avoids a class of "who-wins" races we don't need to solve to ship the live-index bar.

## Tech stack

- **`chokidar@^5`** (current latest is `5.0.0` per `npm view chokidar version` 2026-04-26). Critical v4+ change vs. v3: glob support removed; `ignored` is now a function `(path, stats) => boolean` or a `Matcher` array. Our existing `DEFAULT_EXCLUDE_GLOBS` are still glob strings; we compile them once at watcher startup via `const matchers = globs.map(g => picomatch(g))` and pass the resulting matcher array to chokidar's `ignored` (or wrap them in a single predicate `(p) => matchers.some(m => m(p))`). `picomatch.compose` does NOT exist — earlier draft of this plan was wrong; do not look for it.
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

1. **Liveness within 5 s — across the four shapes that actually break watchers.** The single `echo >> file.md` case is necessary but not sufficient. The validation doc must show all four:
   - **Append:** `echo "slice 3 append" >> ~/projects/scratch.md` → `mm find "slice 3 append"` returns it within 5 s.
   - **Editor save (atomic rename):** open the file in `vim ~/projects/scratch.md`, edit, `:w`. The new content is searchable within 5 s. (Vim defaults to atomic rename via `writebackup`; this is the case that breaks naive rename pairing — see Task 6.)
   - **Move (rename):** `mv ~/projects/a.md ~/projects/b.md` → `mm find` for content of `b.md` returns the renamed path, NOT a ghost row at the old path, within 5 s.
   - **Ignored subtree:** drop a file inside a `node_modules`-shaped path (e.g., `~/projects/foo/node_modules/x.md`) and confirm it is NOT indexed (the watcher's `ignored` predicate fired). This is the only check that catches a broken predicate.
   Each of the four reproduced three times, captured with timestamps in the validation doc.

2. **Daemon stays responsive under load.** While 100 file mutations/sec are flowing through the watcher (a test that writes 100 small files in 1 s, then waits a beat, then writes 100 more), `_ping` p95 latency stays under 50 ms AND p100 (max) under 500 ms. p95 alone hides the tail — 1-in-20 pings would be allowed to be arbitrarily slow, which is the exact signal an agent uses to decide the daemon is dead. Test fails the slice if either bound is exceeded.

3. **F-009 closed.** A test asserts that `extractTextFromFileResult` (or any extractor) never runs while a SQLite write transaction is held. Implementation pattern (prescribed because `vi.spyOn` on a named ESM import is unreliable across transpilation modes — see Task 1 Step 1): mock the extractor module via `vi.mock(...)` at the top of the test file, monkey-patch `db.transaction` to record `[open, close]` timestamps for every callback, and assert no extractor-call timestamp lies inside any transaction window. Test must include a **negative-control assertion** — before Task 1's refactor, the test must fail with a message that quotes the actual overlap timestamps (not just `expected 0, got 0`), proving the spy bound correctly.

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

- **Open follow-up #1: `tests/unit/daemon/cliCommand.test.ts > detached start errors when serverScript is missing` is build-order-dependent.** The test creates a stub `src/daemon/server.js` in a `try/finally`, and a previous run that crashed before `finally` leaves the stub on disk and breaks the next run's "errors when missing" assertion. The fix is a tiny pre-test cleanup block. **Recommendation:** land as **Task 0** on the slice branch — a single commit at the head of the branch, before Task 1's refactor. (Original draft proposed a separate PR; for a 5-line test cleanup that's bikeshedding.) Commit message: `test(daemon): pre-clean leftover server.js stub before missing-script assertion`.

- **F-015 — transport-parity property test.** Slice 2's validation manually diffed `mm_find` / `mm_get` output between stdio and HTTP. A property test that fuzzes inputs and asserts byte-equal `structuredContent` between transports closes the manual loop. **Recommendation:** land as a **separate sibling PR**, NOT bundled into this slice — bundling inflates the watcher PR's review surface and couples a Slice 2 follow-up to a Slice 3 merge. Tracked as the new Task 8 below, but in a separate branch (`tests/transport-parity-property`) opened in parallel with the slice branch.

---

## Task 1: Lift extraction outside the SQLite transaction (`scanFiles` refactor)

**Why:** F-009's follow-up #1. Today `processBatch = db.transaction(batch => batch.forEach(processFile))` and `processFile` synchronously calls `extractTextFromFileResult`. A 30-second PDF extraction holds the writer transaction for 30 seconds, blocking every other writer including the watcher's incoming events. This task does the structural refactor in the *cold-start* `scanFiles` path *first*, with no behavior change visible to callers, so the worker pool task (Task 2) and the watcher task (Task 4) can plug into a clean shape. Doing this in cold-start first is deliberate: the existing scan tests give us regression coverage for free, and the watcher arrives onto an already-corrected pipeline.

**Files:**
- Modify: `src/scanner/fileScanner.ts` (the main refactor)
- Modify: `tests/unit/scanFiles.test.ts` (regression assertion that the transaction is small)
- Modify: `tests/unit/scanCommand.test.ts` if it asserts on transaction shape

**Step 1: Write the failing test.** Required pattern (do NOT use `vi.spyOn` on the named ESM import — it silently misses calls under TS→ESM transpilation):

1. At the top of `tests/unit/scanFiles.test.ts`, declare `vi.mock('../../src/extractors/textExtractor.js', async (importOriginal) => { const real = await importOriginal<typeof import('../../src/extractors/textExtractor.js')>(); return { ...real, extractTextFromFileResult: vi.fn(real.extractTextFromFileResult) } })`. Same shape for `extractImageMetadata` and `extractImageOcr`. Mocking the module guarantees the scanner sees the mocked binding regardless of how it imports.
2. Wrap the test DB so `db.transaction(fn)` is replaced with a recording wrapper: push `{ phase: 'open', ts: performance.now() }` before calling `fn`, push `{ phase: 'close', ts: performance.now() }` after. Each extractor mock pushes `{ phase: 'extract', ts: performance.now() }` on call.
3. Run a scan. Then assert: for every `[open, close]` window in the timeline, no `extract` event lies inside it. On failure, the assertion message must include the offending extract timestamp AND the enclosing window — not a bare `0 !== 1`.

**Step 2: Run test, confirm it fails for the right reason.** Today's code overlaps; the failure message must quote at least one extract-timestamp inside a transaction window. If it fails with "expected 0 got 0" or any message that doesn't contain the actual timestamps, the mock did not bind — fix the mock before continuing. (Negative-control: skipping this confirmation is how a green-but-meaningless test ships.)

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

**Pool size justification.** `min(4, cpuCount - 1)` — extraction is mostly I/O-dominated (PDF parse, image OCR), so 4 workers saturate typical SSD seek throughput; the cap also protects against pathological many-core dev boxes where spawning 31 workers wastes RSS for no parallelism gain. The `cpuCount - 1` term reserves one core for the main thread (RPC + writer queue + chokidar). Degenerate case: on a 2-core CI box this collapses to size 1 (single worker → no parallelism); pool tests must explicitly cover the size-1 case so we don't ship something that only works at size ≥ 2.

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
- `ignored`: derived from `DEFAULT_EXCLUDE_GLOBS` via `picomatch` (chokidar v4+ takes a function or matcher array, NOT glob strings — confirmed via context7). Convert once at watcher startup: `const matchers = DEFAULT_EXCLUDE_GLOBS.map(g => picomatch(g))`, then pass `(p) => matchers.some(m => m(p))` as `ignored`.
- `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }`. Chosen over the original 500 ms because the 5 s ship bar already loses 250 ms to per-path debounce; 500 ms of awaitWriteFinish on top would burn 15% of the budget on every event including small markdown saves. 200 ms is enough for the typical editor "rename-into-place" pattern (vim, code, idea — all complete the rename within 50–80 ms after the last write). For genuinely chunked large-file copies (200 MB PDF), the worst case becomes "indexed in 5–10 s" which we accept and document. Justified in a code comment that quotes this paragraph.
- `persistent: true`, `ignoreInitial: true`. The initial scan is `mm scan`'s job; the watcher only watches forward.
- `alwaysStat: true` so `add`/`change` carry a `Stats` object — we need `mtime`, `size`, **`ino`, and `dev`** for fingerprinting and rename pairing (Task 6).
- `followSymlinks: false`. chokidar defaults to `true`; leaving it true would explode on the first scan root containing a `node_modules` symlink farm or a deliberate `ln -s . loop`. Document in a code comment.

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

**Step 3: Writer queue.** Single-consumer FIFO drained on the daemon main thread. Each drain pass opens a `db.transaction(...)` and applies all in-flight `BatchResult`s. Drain triggers: queue length goes from 0 to >0, or every 50 ms (safety tick).

**Cap behavior — backpressure, not silent drops.** The queue cap is generous (proposed: 10000 entries). On approach to cap, the watcher debouncer is *paused* — `setImmediate`/timer scheduling for new debounce flushes is suspended until the queue drains below a low-watermark (proposed: 5000 entries). Paused events accumulate in the per-path debounce map (which is itself bounded by the path universe, so it cannot grow without bound for a fixed scan root). New chokidar events during pause are coalesced into the existing debounce slots — no event is dropped, only delayed. Resume when below low-watermark.

If for any reason an entry must be dropped (e.g., debouncer map itself exceeded a hard limit), the affected path is added to an in-memory **dirty-paths set**. The drain loop checks this set after each transaction and re-enqueues affected paths as synthetic `change` events; this prevents the silent-stale-row failure mode where a dropped extraction leaves the DB matching the file's stale fingerprint and the next real `change` short-circuits via the fingerprint reuse path (`fileScanner.ts:97`). **Never drop newest** — a newer extraction result represents work the system has already done; dropping it is the worst possible choice.

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

**Shutdown ordering (the inverse is NOT just "reverse" — composition of pool + writer queue requires explicit awaits).** `server.close()` must execute the following in order, awaiting each step:

1. Stop accepting new RPCs (close unix socket and MCP HTTP listener to new connections; in-flight requests drain).
2. Stop the watcher (`watcher.close()`) — no new chokidar events will arrive.
3. Drain the debouncer: force-fire every pending per-path timer so queued events flow into the pool. (`debouncer.flushAll()`.)
4. Drain the pool (`pool.close()` — awaits in-flight extractions, rejects new submissions). Results land in the writer queue.
5. Drain the writer queue (`writerQueue.flush()` — runs final transaction(s) until empty, including any synthetic re-enqueues from the dirty-paths set).
6. Close DB; remove pid file; release MCP listener handle.

Compressing 2–5 into a generic "reverse-order teardown" is the failure mode: SIGTERM during a burst will leave files un-indexed because the debouncer's pending timer fires after the pool is gone. Task 5 Step 4 (below) tests this explicitly.

**Step 3: End-to-end test.** Start the daemon on a `mkdtemp` root with no files. Touch `root/note.md`. Within 2 seconds, `mm_find {query: 'note'}` (over the daemon's internal call path, no MCP) returns the file. Use real timers, real chokidar, real DB. This test is the slice's center of gravity — if it fails, the slice is not done.

**Step 4: Shutdown-during-burst test.** Start the daemon on a `mkdtemp` root. Write 20 small markdown files in rapid succession. Immediately call `server.close()` (do not wait for the debouncer to fire). Restart the daemon on the same DB. Assert `mm_find` returns each of the 20 files. This is the test that catches the "shutdown ordering compressed" failure mode from Step 2 — if even one file is missing post-restart, the shutdown sequence is wrong.

**Step 5: Watcher error handling.** When `WatcherEvent { kind: 'error', error }` arrives, the daemon must: (a) log via the existing `MM_TRACE` facility, (b) increment a counter exposed in the `_status` RPC response (`watcher_errors_total`), (c) NOT crash. If the same error class fires more than 10 times in 60 s, transition the daemon's `_status` to `degraded` so `mm daemon status` surfaces it. Test: inject a synthetic `error` event 11 times within 1 s and assert `_status.degraded === true`.

**Commit message:** `feat(daemon): wire watcher → extraction pool → writer queue end-to-end`

---

## Task 6: Delete + rename via watcher events (closes F-011)

**Why:** Today `unlink` from chokidar would only remove the file row if we wrote that handler. Today's code does not. Renames in chokidar appear as `unlink(old) + add(new)` — pairing them correctly avoids the ghost-row problem.

**Original plan proposed sha256-based pairing per `docs/22` §4. Replaced here with inode + device pairing**, for four reasons that surfaced in plan review:
1. The `file_records` schema has NO `sha256` column today (verified by reading `src/index/schema.ts` before this rewrite) and the scanner does not compute one. Adopting sha256 forces a schema migration AND a scanner-side hashing change AND a backfill — none of which were originally scoped, and any of which would silently break F-011 for the entire pre-existing index.
2. sha256 of a 200 MB PDF on a spinning disk takes longer than the 1 s grace window the original plan proposed — pairing would routinely time out on exactly the large-file case the plan called out.
3. Editor "atomic rename" saves (vim default `:w`, neovim, VS Code "safe save") emit `unlink(P) + add(P)` — same path, **different content**. sha256 pairing would fail (content changed), so every editor save would destroy and recreate the row, losing per-file state and amplifying writes through the pipeline. This is the most common save shape in the wild.
4. Empty files, license files, `__init__.py` stubs, and other small identical files produce real-world content collisions — sha256 pairing of `unlink(empty1) + add(empty2)` would silently re-path the wrong row.

**Inode + device** (`stat.ino`, `stat.dev`) survives renames, is `O(1)`, has no false positives within a single filesystem, and is already in the `Stats` object we get from `alwaysStat: true`. Same primitive used by `find -inum` and `rsync`. Falls back to "treat as separate files" on filesystems where `ino === 0` (some network mounts) — documented as a known limitation.

**Files:**
- Modify: `src/index/schema.ts` (add `inode INTEGER` and `device INTEGER` columns to `file_records`).
- Create: `src/index/migrations.ts` (a `runMigrations(db)` helper, keyed off `PRAGMA user_version`; this is the first real migration the project owns, so the helper is part of the deliverable).
- Modify: `src/index/db.ts` to call `runMigrations(db)` at startup, after `SCHEMA_SQL` runs.
- Modify: `src/scanner/fileScanner.ts` to populate `inode` + `device` on insert/upsert (cheap — already in `stat`).
- Modify: `src/daemon/watcherQueue.ts` (rename pairing logic + atomic-rename detection).
- Modify: writer queue's apply-batch to handle delete + rename.
- New tests for: migration idempotence, rename via inode pairing, atomic-rename-as-change, hard-delete with grace.

**Step 1: Migration helper + schema columns.**
1. Add `runMigrations(db: Database)` that reads `PRAGMA user_version`, runs each registered migration whose version is greater than the stored value, then sets `PRAGMA user_version = N` (the new max). Idempotent.
2. Migration 1: `ALTER TABLE file_records ADD COLUMN inode INTEGER`, `ALTER TABLE file_records ADD COLUMN device INTEGER`. Both nullable — pre-existing rows have NULL, which is fine; they'll be populated on the next time the watcher or scanner touches each path.
3. Wire `runMigrations(db)` into `openDatabase()` (or wherever `db.exec(SCHEMA_SQL)` runs today) so it runs on every daemon start.
4. Test: migration runs cleanly on a fresh DB; runs cleanly on a DB that already has the columns (no `duplicate column` error); `user_version` advances correctly across two consecutive starts.

**Step 2: Scanner + watcher populate inode/device.** Wherever a `file_records` row is upserted today, include `stat.ino` (cast to integer, since `ino` may be a `BigInt` on some platforms — coerce safely) and `stat.dev`. Backfill happens organically: any file the watcher or scanner touches gets its inode populated. Pre-existing rows whose path is never touched again retain `inode = NULL` — the rename-pairing fallback path covers this case (Step 3).

**Step 3: Rename + delete logic in `watcherQueue.ts`.**
- **Atomic-rename-as-change first.** When the latest event for path P is `unlink` and a fresh `add` arrives for the SAME path P within a 250 ms grace, collapse to a single `change(P)` job. This is the editor-save case and is the most common shape; handle it before any inode lookup.
- **Inode-paired rename.** When `unlink(P)` arrives (and is not collapsed by the atomic-rename rule above), look up the current `(inode, device)` from the DB row for P. Mark the row "pending deletion" with a 1 s grace. If an `add(Q)` arrives within the grace AND `(stat.ino, stat.dev)` from `Q` matches the held `(inode, device)`, treat it as a rename: update the row's `path` to `Q` (and refresh `inode`/`device` if they changed — they shouldn't on a same-FS rename), cancel the deletion.
- **Fallback for NULL inode (pre-existing rows + ino-less filesystems).** If the held inode is NULL, skip pairing — treat as plain delete-then-add. Document in validation doc as a known limitation: pre-existing rows that are renamed on a daemon's first run won't pair. Acceptable because (a) it self-heals on the next watcher event for either path, and (b) most users rename files, not pre-existing-from-a-stale-index files.
- **Grace expiry.** If 1 s passes with no matching `add`, hard-delete the row + text blobs in the next writer drain. (Hard-delete vs tombstone choice still per the out-of-scope section.)

**Step 4: Hard-delete read-race.** `mm_get` reads from the DB only and never `fs.read`s the underlying path; assert this in a test (mock `fs.readFileSync` and confirm `mm_get` does not call it). With this assertion, the worst stale-row case is "agent receives a row whose underlying file was deleted 50 ms ago," which is acceptable — the agent's next call will reflect the deletion. Without this assertion, `mm_get` could throw `ENOENT` to the agent on a query that was valid moments earlier.

**Step 5: Tests.**
- `mv a.md b.md` (different paths, same inode) → updates the existing row's path, no ghost.
- `vim a.md` → `:w` (atomic rename, same path) → row updated in place via the change-collapse rule, no ghost, no temp-row created.
- `rm a.md` → row + text blobs removed after 1 s grace.
- Concurrent moves of three files within 100 ms — each pairs to its own original by inode, no cross-contamination.
- Pre-existing row with `inode = NULL` is renamed → row is deleted and a new row is created (fallback behavior); validate this is what the test asserts, not silent breakage.
- Migration idempotence (covered in Step 1's test).

**Commit message:** `feat(daemon): handle unlink and rename via inode pairing (closes F-011)`

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
5. Assert `_ping` p95 < 50 ms AND p100 (max single ping) < 500 ms across all measurements. The p100 bound exists because p95 alone allows 1-in-20 pings to be arbitrarily slow — the exact pattern an agent uses to mark the daemon dead.

**Step 1b: Liveness battery (separate test).** Beyond the synthetic 100/sec stress, validate the four real-world shapes from ship-bar item 1:
- Append (`echo >> file.md`) → indexed within 5 s.
- Editor save (vim atomic rename) → row updated in place within 5 s; no ghost row.
- Move (`mv a.md b.md`) → row path updated, no ghost, within 5 s.
- Drop into ignored subtree (`node_modules/...`) → NOT indexed (assert on DB state after 5 s).
The vim case is the one where naive implementations break — if it ships green, the atomic-rename collapse from Task 6 Step 3 is wired correctly.

**Step 2: Run, tune.** If the test is flaky on slow CI, raise the threshold rather than weaken the assertion — but the threshold itself is the ship-bar contract. If we cannot hit p95 < 50 ms AND p100 < 500 ms at 100 mutations/sec on a 4-core dev box, the architecture is wrong and we owe a re-design before shipping. Note: 2-core CI may legitimately hit p100 spikes from the worker-pool degeneracy (size 1 = no parallelism); document the test's minimum core count and skip it on smaller runners rather than weaken the bound.

**Commit message:** `test(daemon): assert _ping p95 < 50ms while watcher ingests 100 mutations/sec`

---

## Task 8: F-015 — transport-parity property test (separate sibling PR — NOT in Slice 3)

**Why moved out of the slice:** Plan review flagged that bundling this into the watcher PR (a) inflates the watcher review surface, (b) couples a Slice 2 follow-up to a Slice 3 merge, (c) lets a flaky property test block a watcher merge. Per `feedback_pr_workflow`, slice PRs stay focused.

**Plan:** Open a separate branch `tests/transport-parity-property` in parallel with the slice branch. PR title: `test(mcp): transport-parity property test for mm_find/mm_get/mm_recent (closes F-015)`. May land before or after Slice 3 — order does not matter.

**Files:** `tests/integration/transportParity.test.ts`

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

**Step 4: Document any false negatives observed during 48 h of dogfooding.** After running the daemon on the contributor's real machine for at least 48 hours, list any cases where a file mutation was NOT reflected in `mm find` within the 5 s ship bar. If none were observed, write "none observed in 48 h" and move on. (Original draft pre-invented one case to "look honest" — replaced because speculation isn't evidence; real false negatives come from running the thing, not from imagining them.)

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
- **awaitWriteFinish 200 ms tax:** Adds 200 ms of latency to every event because chokidar polls for stability before emitting. Lowered from 500 ms to 200 ms in plan revision; together with 250 ms debounce that's 450 ms of fixed overhead, leaving 4.55 s of the 5 s budget for queueing + extraction + write. Large PDFs that take > 4 s to extract will slip the bar; documented as accepted trade-off.

- **Network-mounted scan roots (NFS, SMB, sshfs, fuse):** inotify does not work reliably (or at all) on most non-local filesystems. With the plan as written, the watcher will start clean, emit `ready`, and silently never fire events for files on a network mount — `mm find` will lie about freshness with no signal to the user. Slice 3 detects this at startup (`fs.statSync(root).dev` against a known network-fs major list, or `statfs` where available) and logs `WARN: scan root X is on a non-inotify-capable filesystem; events will be missed`. A polling fallback for network mounts is **deferred to Slice 5** explicitly.

- **Symlink loops + symlink-farmed scan roots:** chokidar defaults to `followSymlinks: true`, which would explode on the first scan root containing a `node_modules` symlink farm or a deliberate `ln -s . loop`. Slice 3 sets `followSymlinks: false` (Task 3 Step 2) and documents in code comments. A user who actually wants symlinked content indexed must add the target paths as scan roots themselves — acceptable for v1.

- **Unreadable files (EACCES on `read(2)` despite `stat(2)` working):** the worker pool may receive an extraction job for a file the daemon cannot read (root-owned, mode 0600, on a shared dev box). The worker must `try/catch` extractor calls and post back a structured error result; the writer queue records the file row with no text blobs (the row is observable via `mm_find` on path/name, just not searchable on content). Tested in Task 2.

- **chokidar `error` event:** the watcher emits `error` on inotify watch limit, on `EACCES` reading a watched dir, on the FS being unmounted under us. Handled per Task 5 Step 5: log + counter + degraded-state transition after threshold.

## Open questions to resolve during execution (not blockers)

- ~~Should the writer queue's drain interval (50 ms) be tunable via `MM_WRITER_DRAIN_MS`?~~ **Resolved: no.** Hard-code 50 ms. Undocumented env knobs rot — six months later someone finds it set in `~/.bashrc` and can't remember what it does. If tuning is ever needed, add it then with a doc entry.
- Should `mm_subscribe`'s design doc include an example `since`-based replay strategy? The internal event emitter doesn't persist events; replay across daemon restarts is not on the table without the activity-events table. Note in the design doc as Phase-4-or-later.
- Does the worker pool need a graceful "drain in flight" mode for daemon shutdown? `close()` should `await` in-flight jobs before terminating workers; new jobs reject. Implement in Task 2 and document.
