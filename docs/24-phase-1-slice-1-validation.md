# Phase 1 Slice 1 Validation

**Dated:** 2026-04-19.
**Host:** Linux 6.17.9-76061709-generic.
**Slice:** Phase 1 Slice 1 — daemon skeleton + Unix socket IPC.

This file records the real-machine ship-bar check required by Task 10 of `docs/plans/2026-04-19-phase-1-slice-1-daemon-skeleton.md` and by D-016 in the decision log: same query, daemon-up vs daemon-down, must produce identical results.

## Index Size At Validation

Captured directly from `~/.local/share/machine-memory/machine-memory.sqlite` at run time:

| Table          | Count   |
| -------------- | ------- |
| `file_records` | 20,000  |
| `repo_records` | 90      |
| `text_blobs`   | 18,244  |

DB file size: ~402 MB. This is the live local index that Phase 0 / Phase 1 scans of `~/projects`, `~/Downloads`, `~/zCoursework`, `~/Desktop`, and the validation root populated, not a synthetic fixture.

## Build Under Test

- Branch: `main`.
- Slice 1 commits (in order): `ebc7131`, `db78c34`, `7c58d5d`, `3c36fa8`, `90a3285`, `9755ef2`, `96fa86c`, `c6f5c27`, `ffa9462`, `dedd422`, `dc33658`, `9f6353e`, `1f7f7bf`.
- `npm run build`: clean (exit 0).
- `npm test`: 71 tests pass across 13 files (includes the new `tests/unit/daemon/*` and `tests/integration/daemonRoundtrip.test.ts`).

## Proof Queries

The three queries were chosen to overlap with `docs/19-phase-1-validation.md` so the comparison is apples-to-apples with the prior Phase 1 validation: one tests fuzzy/typo recall, one tests OCR-text recall against a real screenshot, one tests multi-token plural-stemmed recall on real coursework content.

The ship-bar property under test is **byte-identical output between direct-DB mode (daemon down) and daemon mode (CLI delegating over `mmd.sock`)**, not the relevance ordering itself.

For each query the same command was run twice — once with no daemon and once with `mmd` listening — and the outputs were diffed.

### Query 1 — `gitinsteroid`

Why: the canonical typo-tolerant repo recall query from doc 19 §1 and the literal driver of D-015. Exercises the fuzzy + token paths in `findMatches`.

Direct vs daemon diff: **empty**.

Top result: `13-decision-log.md` (id `b8e96c6db6a23bb968ebd32ab52ff072d91d12be`), surfaced because the decision log itself contains the `gitinsteroid → gitonsteroid` example. (This is different from doc 19's `gitonsteroid` repo top hit because the live index now also contains the docs directory of this repo, where the typo string appears literally; the parity property is what this slice tests.)

### Query 2 — `Scanned 20 MCP Server Configs for Security Vulnerabilities`

Why: the canonical screenshot-OCR recall query from doc 19 §2. Exercises FTS strict-AND on a long multi-token query and routes the request through the same OCR-blob path that has historically been most sensitive to ranker drift.

Direct vs daemon diff: **empty**.

Top result: `19-phase-1-validation.md` (the doc that records the original validation, which itself contains the query string verbatim). The original screenshot file is still indexed but the docs file outranks it on this index because it has more matching token coverage; again, parity is what this slice validates.

### Query 3 — `stat hw`

Why: the multi-token plural-stemming + word-boundary query from doc 19's Phase 1 reopen section. Exercises the plural-`s` soft-stemming path and the path/name split added in the Phase 1 reopen.

Direct vs daemon diff: **empty**.

Top result: `package-lock.json` from `~/projects/Syzygy`. This index does not currently contain the `Stat hw` markdown / DOCX coursework files that doc 19 surfaced (Coursework was not in the most recent rescan); the top hit on the present index is a package manifest where `[stat]` and `[hws6U…]` token fragments match. This is a relevance observation about the live index state, not a Slice 1 regression — the parity property still holds. Captured as a follow-up below.

## `mm show` Parity

Picked id: `b8e96c6db6a23bb968ebd32ab52ff072d91d12be` (Query 1's top result, `13-decision-log.md`).

Direct vs daemon diff: **empty**. Both paths returned identical `type / name / path / extension / modified / source root / metadata / indexed text` blocks, including the prefix of the markdown body extracted by the `text/markdown` extractor.

## Daemon Lifecycle

Observed sequence:

1. `mm daemon status` (before start): `mmd: stopped (socket: …/mmd.sock)`. No `mmd.pid`, no `mmd.sock` on disk.
2. Initial attempt to launch via `nohup node dist/daemon/server.js &` did spawn the listener (socket created, daemon-mode `mm find` would have worked because the CLI probes the socket, not the pid file), but **`server.js` itself does not write a pid file**, so `mm daemon status` correctly reported "stopped". This is by design — `server.js` is the systemd entry point and pid management is owned by `mm daemon start`'s background spawner.
3. Switched to the supported start path: `mm daemon start` → `mmd started (pid 511174)`. Pid file and socket both present.
4. `mm daemon status` (after start): `mmd: running (pid 511174, uptime 1s, version 0.1.0)`. The `_ping` round trip over the socket succeeded.
5. All three `mm find` queries and the `mm show` lookup ran against this daemon.
6. `mm daemon stop`: `mmd stopped (pid 511174)`. SIGTERM was delivered, the daemon exited within the 5 s grace window, the pid file was unlinked, and the socket was unlinked by the daemon's own `close()` handler.
7. `mm daemon status` (after stop): `mmd: stopped (socket: …)`.
8. `pgrep -af 'dist/daemon/server.js|node .*daemon'`: no matching processes. No orphans.

## Verdict

Slice 1 ship bar (per `docs/plans/2026-04-19-phase-1-slice-1-daemon-skeleton.md`):

- [x] `mm find` returns identical results via socket vs direct DB on all three proof queries (diffs above).
- [x] `mm show` returns identical output via socket vs direct DB on the picked id (diff above).
- [x] `mm daemon status` truthfully reports `running` / `stopped` (and would report `stale pid file` per the unit tests; the live run did not produce a stale state).
- [x] `mm daemon stop` terminates the daemon cleanly, removes the pid file, and the socket is unlinked.
- [x] All existing tests pass (71/71).

**Status:** Verified complete.

## Follow-ups Surfaced By This Validation

- F-012 (new): document in the Slice 4 install/runbook that `node dist/daemon/server.js` is the **systemd-managed** entry point and does not write `mmd.pid`; `mm daemon status` reads pid state, so any operator-launched test daemon should go through `mm daemon start` (or systemd) if the operator wants `status`/`stop` to work. Not a bug — but easy to trip over, as this validation did on first attempt.
- F-013 (new): the live `~/.local/share/machine-memory` index does not currently include the Coursework `Stat hw*.md/.docx` files that doc 19's Phase 1 reopen surfaced. This is a stale-index observation, not a code regression. Either re-scan `~/zCoursework` before the next validation pass or pick proof queries that target content known to be in the present index.
- No protocol drift, no ranking drift, no encoding drift between direct and daemon paths was observed on these queries. Confidence is high that the daemon path is a true delegate of the direct path for `mm_find` and `mm_get`.
