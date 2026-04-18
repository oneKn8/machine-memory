# Phase 1 Followups And Deferred Work

This file captures work that is related to Phase 1 but is not being handled in the current reopen cycle.

The purpose of this file is durability: anything written here survives the conversation that discovered it, so nothing quietly drops out of memory.

## Conventions

Every entry has:

- a short title
- the discovery context (how it surfaced)
- the honest current status
- a decision on when it is worth doing

## Active Followups

### F-001: Fuzzy ranker strategy for long natural-language queries

Discovery: During the Phase 1 reopen test, the query "a book about stats" returned only repos because the fuzzy similarity function compared the whole query against short file names. Even with the ranker cleanup planned in the reopen (per-token fuzzy, stemming, stop-word drop), a deeper pass is worth doing once more real queries are collected.

Status: partial fix planned in the reopen; deeper rework deferred.

When to do it: after the reopen lands and a small corpus of real failing queries has been collected in validation notes.

### F-002: Re-extraction policy surface

Discovery: The fingerprint cache was conflating "file seen" with "file extracted". The reopen fixes this in the scanner, but there is no user-facing control to force re-extraction of a specific extractor across the whole index (for example, if a new extractor is added later and you want to re-run it across everything).

Status: not planned for the reopen.

When to do it: when a second extractor-family change lands (for example, better screenshot OCR or a new DOCX strategy).

### F-003: PDF extraction fallback coverage audit

Discovery: The extractor has an internal latin1/zlib fallback for PDFs without pdftotext, but it is not validated on a broad corpus. Some PDFs may still yield no text even when pdftotext does not exist on the machine.

Status: not urgent (the machine has pdftotext).

When to do it: before any release that targets a machine without poppler-utils.

### F-004: DOCX extraction edge cases

Discovery: The reopen adds DOCX extraction via `unzip -p file.docx word/document.xml`. This does not handle:

- password-protected DOCX
- DOCX with content split across multiple `word/document*.xml` files
- DOCX that stores text inside `word/footnotes.xml`, `word/endnotes.xml`, or `word/header*.xml`

Status: baseline DOCX extraction is acceptable for Phase 1. Edge cases deferred.

When to do it: when a real document fails recall because of one of these cases.

### F-005: Re-extraction on scan does not reclaim unchanged files whose extractor has improved

Discovery: Even after the incremental-cache fix, if an extractor's logic is upgraded, previously-extracted files will still be skipped because their blob already exists.

Status: acceptable for Phase 1. Future phases will need a lightweight extractor-version tag in the blob so a version bump triggers re-extraction.

When to do it: when the next extractor upgrade ships.

### F-006: Config for stop-words and stemming rules

Discovery: The ranker cleanup hard-codes a small stop-word list and a plural-s stemmer. These are reasonable defaults but are not user-configurable.

Status: hard-coded is fine for Phase 1.

When to do it: once the product has enough users for vocabulary variance to matter, or if a user hits a query where the stop-word list hurts them.

### F-007 (resolved): Full-`~/projects` scan appeared to stall

Original symptom: running `mm scan --root ~/projects --ocr-mode off` appeared to hang at 0% CPU for 27+ minutes with no DB writes and no stdout.

Real root cause: the scanner was wrapping the entire scan in a single `db.transaction` call. On large roots, the uncommitted transaction accumulated in the SQLite WAL (observed to grow past 360 MB), the main database file timestamp never advanced during the scan, and the process was I/O-bound on WAL growth which made `ps` report ~0% CPU. There was no actual hang — just slow, silent progress that impatient operators killed before it could finish.

Fix: scanner now processes files in batches (default 500) with one short-lived transaction per batch; a new `onProgress` callback lets the CLI print live progress to stderr. This keeps the WAL checkpointed (observed ~30 MB instead of 360 MB) and makes interrupts safe — committed work survives.

Follow-through: see followup F-009 below for the remaining per-batch fsync cost. The Phase 1 reopen validation after this fix shows **91 of 93 indexed PDFs** and **13 of 14 indexed DOCX files** have text blobs. The three remaining unextracted files are all legitimate content limitations (two image-only PDFs and one mislabeled `.docx` that is actually 56 bytes of plain text), not extractor bugs.

### F-009 (resolved 2026-04-18): Per-batch commit cost on large scans

Original symptom: After switching from a single unbounded transaction to per-batch commits (F-007 fix), whole-root `~/projects` scan throughput dropped from roughly 30-50 files/sec to ~7.5 files/sec. Correctness and UX improved significantly, but raw speed regressed.

Root cause confirmed via research in `docs/22-phase-2-research.md` §1: each batch commit was paying `synchronous=FULL` fsync cost at SQLite defaults. The prior single-transaction design amortized this into one fsync at the end.

Fix shipped in commit `cf74c81`: set five additional pragmas at database open time in `src/index/db.ts` — `synchronous=NORMAL` (primary speedup, WAL-safe), `cache_size=-64000`, `temp_store=MEMORY`, `mmap_size=268435456`, `wal_autocheckpoint=5000`, `journal_size_limit=67108864`.

Measured result on `~/projects` cold scan (index wiped, OCR off, batch size 500):

- Before: ~7.5 files/sec (the F-007 investigation baseline)
- After: **68 files/sec** (19,500 files in 286 seconds)
- **~9× speedup**, inside the 5–10× range SQLite's own docs predict for `synchronous=NORMAL` in WAL mode.

Projected full `~/projects` scan time drops from ~2.5 hours to ~18 minutes. This unblocks F-010 scheduled scans: a 30-minute timer running an 18-minute scan is now practical.

Deferred follow-up (not urgent): hoisting pdftotext/unzip/tesseract subprocess spawns *outside* the batch transaction so the SQLite lock isn't held across subprocess I/O. Would unlock parallel extraction via worker threads. Do this if the 68 f/s ceiling starts feeling slow for larger roots.

### F-008: Vague natural-language queries with semantically loose words

Discovery: The query "a book about stats" used to return only recent repos. After the Phase 1 reopen, it returns files (not repos), and with a slightly more specific phrasing (e.g., "stat hw", "stats homework", or "stats pdf") the exact documents the user wanted appear at the top. The literal phrase "a book about stats" still does not surface the `STAT HW 2 QUESTIONS SET.pdf` or `Stat hw 3.docx` as the #1 hit because the token "book" also appears in many unrelated files (bookmarks, bookings, playbooks) and those files contain both "book" and "stat" while the STAT HW documents do not contain the literal word "book".

Status: the ranker is dramatically improved over the Phase 1 baseline. The remaining gap is a general NLP/ranking nuance, not a new regression.

When to do it: after a small corpus of real vague queries is collected from actual use; then consider semantic scoring or learned re-ranking (this is also consistent with D-011's note that semantic retrieval lands after baseline search is strong).

### F-010: Automatic and scheduled scans for dump-and-forget files

Discovery: scanning today is fully on-demand (`mm scan`). A file dropped into `~/Downloads` and never opened stays invisible to the index until the user manually triggers another scan. This breaks both sides of the north star: the human cannot recall something they forgot they had, and an AI agent cannot reason over files that arrived since the last explicit scan.

Two levels of fix:

- **Scheduled scan (near-term, Phase 1.5 / Phase 2):** ship documentation and an example `systemd --user` timer unit that runs `mm scan` every 30 minutes with the incremental cache. The Phase 1 reopen already made rescans cheap enough for this to be practical. Depends on F-009 being addressed first, otherwise a 30-minute timer running a 30-minute scan is useless.
- **Real-time (Phase 6):** `inotify`/`fanotify` event streams feeding the index as files change, per the roadmap's Phase 6 commitment.

Status: not in Phase 1. The scheduled-scan approach is small and practical once F-009 lands.

When to do it: right after Phase 2 activity indexing, so the activity stream gets fresh data automatically instead of only when the user remembers to scan.

### F-011: Delete and rename detection

Discovery: the fingerprint cache catches edits (mtime change → re-extract), but it does not notice files that were deleted or renamed. Deleted files leave stale rows pointing at paths that no longer exist on disk; renames create a new record at the new path while the old record sits in the index as a ghost.

Active harm today is small: a search can return a path that no longer resolves, which is mostly a trust leak rather than a crash. But for Phase 2 (work resurrection), rename and delete are *signals*, not noise — they are exactly the kind of activity the user will want to ask about ("what did I move last Tuesday?", "what did I clean out before the demo?").

Plan:

- At scan time, collect the full set of paths returned by fast-glob per root; diff against the set of existing `file_records` with the same `source_root`. Paths present in DB but missing from disk are deletions — record them as activity events (Phase 2) and mark the record accordingly.
- Rename detection is harder because filesystems do not track renames natively. A content-hash on small/medium files (or a (size, first-N-bytes) tuple) lets the scanner notice "this new path has the same content as an old path that just disappeared." Leave this for Phase 2 when the activity model exists.

Status: Phase 2 scope.

When to do it: alongside the initial activity-event table in Phase 2. Do not retrofit onto Phase 1 in isolation — the delete/rename signal only becomes useful once there is somewhere to store activity.

### F-012: Agent-oriented output shapes and stable retrieval API

Discovery: per D-018, AI agents are a first-class user. But today the entire output surface is prose formatted for a human terminal: numbered results, free-form `whyMatched` strings, pretty snippets. An agent consuming this has to re-parse text to get at the structured data it already needs (result id, path, score, provenance type, snippet span).

What this looks like concretely when Phase 5 lands:

- A `--json` flag or a sibling `mm query` command that emits `{ results: [{ id, type, path, score, provenance: [...], snippet }], query: ..., totalCandidates: N }`.
- Stable result IDs (we already have sha1-of-path for files) so an agent can cite a result and re-fetch its full record.
- Smaller default result counts for agents (3–5) than for humans (10), with provenance attached to each.
- Provenance strings that are already structured (`{extractor_type, byte_span, confidence}`) rather than only a pretty snippet string.
- Agent-aware ranking hints (e.g., a coding agent can pass `?preferKinds=code,readme`) without replacing the ranker — same engine, additive signal.

Status: the ranker and DB shape do not need to change. What needs to stabilize now is the *data shape* that passes between the ranker and the output layer, so Phase 5 is a thin adapter instead of a rewrite.

When to do it: the adapter layer ships in Phase 5 with the MCP interface. But whenever Phase 2 or Phase 3 touches the internal retrieval API, prefer a shape that is already agent-friendly so we are not paying a refactor tax later.

## Resolved

(Entries move here once a followup is closed, so the history is not lost.)
