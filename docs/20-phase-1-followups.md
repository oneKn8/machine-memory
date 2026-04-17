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

### F-007: Full-`~/projects` scan stalls at 0% CPU

Discovery: During the Phase 1 reopen validation, running `mm scan --root ~/projects --ocr-mode off` stalled at 0% CPU for 27 minutes with no database writes and no stdout. Smaller scans of `~/Downloads`, `~/zCoursework`, and `~/Desktop` completed in seconds. The stall is unrelated to the cache, DOCX, or ranker fixes; it was present before the reopen.

Likely causes to investigate:

- fast-glob traversing a very large or symlink-looping subtree that is not covered by `DEFAULT_EXCLUDE_GLOBS`
- a single `pdftotext` or `unzip` subprocess hanging on a malformed file and blocking the whole transaction
- the whole-root transaction model holding too long

Status: not blocking Phase 1 closure. The reopen is validated on Downloads + zCoursework + Desktop, which already covered all 88 previously-broken PDFs and 11 DOCX files except those under `~/projects/**`. A targeted subset scan of the affected `~/projects` subdirectories is a reasonable workaround until this is rooted out.

When to do it: before any larger announcement of Phase 1 or before enabling automated periodic scans.

### F-008: Vague natural-language queries with semantically loose words

Discovery: The query "a book about stats" used to return only recent repos. After the Phase 1 reopen, it returns files (not repos), and with a slightly more specific phrasing (e.g., "stat hw", "stats homework", or "stats pdf") the exact documents the user wanted appear at the top. The literal phrase "a book about stats" still does not surface the `STAT HW 2 QUESTIONS SET.pdf` or `Stat hw 3.docx` as the #1 hit because the token "book" also appears in many unrelated files (bookmarks, bookings, playbooks) and those files contain both "book" and "stat" while the STAT HW documents do not contain the literal word "book".

Status: the ranker is dramatically improved over the Phase 1 baseline. The remaining gap is a general NLP/ranking nuance, not a new regression.

When to do it: after a small corpus of real vague queries is collected from actual use; then consider semantic scoring or learned re-ranking (this is also consistent with D-011's note that semantic retrieval lands after baseline search is strong).

## Resolved

(Entries move here once a followup is closed, so the history is not lost.)
