# Phase 1 Slice 3 Validation

> **Status:** Initial validation captured during slice implementation. Contributor 48-hour dogfooding section open — to be filled in after running the daemon against real `getDefaultScanRoots()` for at least 48 h.

## Environment

| | |
|---|---|
| OS | Linux 6.17.9-76061709-generic (Pop!_OS) |
| Node | v22.17.1 |
| chokidar | ^5.0.0 (latest as of plan date) |
| picomatch | ^4.0.4 |
| Hardware | 16-core dev box (`availableParallelism()` returns 16) |
| `fs.inotify.max_user_watches` | 65536 (default raised by kernel since recent versions; original Slice 3 plan assumed 8192. Still well below the 524288 threshold the plan flagged as "recommend sysctl override" — see §inotify posture below.) |

## Ship-bar items

### 1. Liveness within 5 s — across the four mutation shapes

| Shape | Status | Evidence |
|---|---|---|
| Append (`echo >> file.md`) | ✓ Verified by `tests/integration/daemonLivePath.test.ts > indexes a freshly-written file within the 5 s ship bar` (real chokidar, real worker pool, real SQLite). Local timing: indexed in **548 ms**. |
| Editor save (atomic rename) | ◐ Indirectly verified: `tests/unit/daemon/watcherQueue.test.ts > latest-event-wins` covers the unlink+change collapse at the debouncer level, and `serverCore.ts` `onAdd` has the explicit atomic-rename-as-change rule (rule 1 of the inode-pairing decision table). Direct vim/code save not yet exercised in CI; flagged for 48h dogfooding. |
| Move (`mv a.md b.md`) | ✓ Verified by `tests/integration/daemonLivePath.test.ts > mv a.md b.md updates the existing row in place via inode pairing (closes F-011)` (746 ms locally) AND the sidecar-orphan regression test (`text_blobs` and `text_blobs_fts` for the old id are both 0 post-rename, 693 ms locally). |
| Drop into ignored subtree (`node_modules/...`) | ◐ Indirectly verified: `tests/integration/daemonWatcher.test.ts > does not emit for files matching the ignore predicate` covers the predicate-fires path. Direct `node_modules`-shaped subtree check is part of the 48h dogfooding battery. |

### 2. Daemon stays responsive under load (`_ping` p95 < 50 ms AND p100 < 500 ms)

✓ Verified by `tests/integration/daemonResponsivenessUnderLoad.test.ts`. Producer writes 100 small markdown files at ~100 mutations/sec across two bursts; pinger fires every 20 ms over 5 s. Local result: stress test ran in 5.07 s; both bounds met. (The test will skip on runners where `availableParallelism() < 3` rather than weaken the bound — plan-prescribed degenerate-case handling.)

### 3. F-009 closed (extraction never runs inside a SQLite write transaction)

✓ Verified by `tests/unit/scanTransactionIsolation.test.ts`. Mocks the three extractor modules to record `performance.now()` per call, wraps `db.transaction` to record `[open, close]` per callback, asserts no extract timestamp lies inside any window. Negative control verified during development: pre-refactor, the test failed with quoted timestamps showing 5/5 extracts inside the transaction window; post-refactor, 0 overlaps.

### 4. F-011 closed (delete + rename via watcher events)

✓ Verified end-to-end in the live-path tests above. `mv a.md b.md` updates the existing row's path AND id atomically across `file_records`, `text_blobs`, `text_blobs_fts`. `rm a.md` removes all three sidecars after the 1 s grace window (covered by `> reflects a delete via unlink`).

### 5. Slice 1 + 2 still pass

✓ All pre-existing tests pass alongside the new Slice 3 tests. Total: **141 passing across 24 files** as of commit `e4f8a0f`. No regressions in `mm daemon start/stop/status`, `mm find`/`mm show`, stdio bridge, or HTTP transport surfaces.

### 6. Build hygiene

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npm test` on a fresh `npm ci`: 141/141 green (after `npm run build` first — the worker pool + stdio bridge tests both hard-fail without the dist artifact).

## inotify posture

`cat /proc/sys/fs/inotify/max_user_watches` on the contributor's machine returned **65536**. The plan flagged 524288 as the recommended sysctl override for users with deep monorepos. 65536 is enough for typical use (`~/projects` < 5000 files for most contributors) but a user with a `node_modules`-heavy mega-repo could hit the limit silently — the watcher would emit an `error` event, the daemon's `watcherErrorCount` would increment, but Phase 1 has no UI surface that exposes this to the user.

**Action item for Slice 4 (installer):** detect the current value via `cat /proc/sys/fs/inotify/max_user_watches` and suggest `sudo sysctl fs.inotify.max_user_watches=524288 && echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/40-machine-memory.conf` if below the threshold.

## 48-hour dogfooding observations

> **To be filled in by the contributor after running the daemon against real `getDefaultScanRoots()` for at least 48 h.** Per plan revision (replacing the original "pre-document one false negative" step), record any cases where a file mutation was NOT reflected in `mm find` within the 5 s ship bar. If none were observed in 48 h, write "none observed in 48 h" and move on.

- [ ] Daemon ran continuously for at least 48 h: _from_ … _to_ …
- [ ] Real-world editor saves (vim, neovim, VS Code, IntelliJ — whichever the contributor actually uses) reflected in `mm find` within 5 s.
- [ ] Renames (`mv` from a shell, drag-and-drop in a file manager) handled correctly: row updates in place, no ghost.
- [ ] `mm find` queries during peak watcher activity (compile finished → many file writes in a burst) stayed responsive.
- [ ] Any false negatives observed: _list paths and root cause if known, else "none observed in 48 h"_.

## Known limitations

Surfaced during implementation, intentionally accepted:

1. **Pre-existing rows with `inode = NULL` rename to a new path** → row is deleted and a new row is created (fallback per Task 6 §Step 3). Self-heals on the next watcher event for either path. Acceptable because most users don't rename their pre-Slice-3 indexed files.

2. **Network-mounted scan roots (NFS/SMB/sshfs)** → inotify does not fire reliably (or at all) on most non-local filesystems. Slice 3 does NOT detect this; the watcher emits `ready` and silently never sees events. Plan'd action moved to Slice 5 (cross-platform): detect at startup via `fs.statfs` against known network-fs majors.

3. **Files opened via `mmap` without `close(2)`** → chokidar may take longer than 5 s to emit, slipping the bar. No real test coverage; flagged for the 48h dogfooding observation list.

4. **macOS / fsevents path** → not exercised. Slice 5 owns the macOS port. The chokidar wrapper does pass `awaitWriteFinish` and `followSymlinks: false` which apply uniformly across platforms, but no claims about behavior on macOS or Windows are made in this slice.
