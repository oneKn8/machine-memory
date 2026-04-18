# Current State

This file is a snapshot of what has already been decided and what the current direction is.

Use this when you want the fastest possible orientation.

For a dated checkpoint of the current truth, also read:

- [Memory snapshot (2026-04-18)](./21-memory-snapshot-2026-04-18.md)

## Working Name

- Machine Memory

## Core Product Idea

Build a private, local-first memory engine for a personal computer — the system that decides what context gets seen before any thinking happens, for the human who owns the machine and for any AI the human works with.

**Canonical architecture:** [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md). The product is an always-on daemon (`mmd`) + thin human CLI (`mm`) + embedded MCP server, installed with `npx machine-memory init`. Phases are layers of that one product, not separate ship frames (see D-019).

Important context:

- this project originally started from a different ambition: an autonomous multi-agent research lab
- the direction intentionally pivoted into machine memory and retrieval because it exposed a sharper, more immediate product pain
- the long-term technical horizon still includes deep Linux system integration and possibly near-kernel observability, but only after the search and memory product is real

The first pain it solves is:

- "Where the hell is that file?" (shipped, Phase 0)

The larger vision is:

- the substrate AI agents call over MCP, so they stop burning context on blind file crawls
- an LLM-compiled wiki layer that summarizes your projects, people, and concepts from what actually changed on disk
- a conversational surface where both humans and agents ask "what was I doing?" and get grounded, cited answers
- all of it running locally, installed in one line

See [`01-product-thesis.md`](./01-product-thesis.md) for the full north-star statement.

## V1 Wedge

The first version is a CLI-first local search tool for:

- repos
- files
- PDFs
- screenshots
- images
- downloads

It should help users recover things they know exist but cannot locate.

Current implementation status:

- the repo is initialized and buildable
- local scanning, indexing, and `find`/`show`/`doctor` commands exist
- repo metadata and text extraction are wired into SQLite + FTS5
- screenshot and image metadata indexing exists
- screenshot/image OCR exists through system `tesseract`
- image EXIF enrichment is supported when `exiftool` is installed
- OCR-backed search results can now explain that they matched OCR text instead of only path text
- incremental scan caching skips unchanged files and reuses prior extraction work
- configurable exclusions and scan roots exist through config and CLI overrides
- typo-tolerant repo recall and mixed-source ranking now demote noisy dependency/temp paths
- `show` surfaces mime, source root, metadata, and indexed provenance snippets
- real-world validation has been run against an actual local repo plus actual local screenshot, PDF, and image content
- DOCX body extraction is supported through system `unzip`
- the incremental scan cache re-runs text extraction when a file's expected text blob is missing, so files indexed before an extractor existed are healed automatically on rescan
- ranker filters stop-words, soft-stems plural tokens, rewards word-boundary name matches, and uses per-token fuzzy similarity on longer queries while preserving whole-query fuzzy recall for single-word typo cases
- scans commit in batches (default 500 files) instead of holding a single transaction across the whole root, with live progress on stderr and a bounded WAL; an `MM_TRACE=1` env flag emits per-batch and per-extraction trace lines for future performance work

Phase 1 status:

- complete, reopened on 2026-04-17 to close PDF/DOCX extraction, vague-query ranking, and scan-stall gaps, re-validated against the real machine index (see `docs/19-phase-1-validation.md` "Phase 1 Reopen" and "F-007 Resolved" sections)

## Locked Early Decisions

- Use TypeScript for implementation
- Use Node.js for runtime
- Use SQLite for metadata storage
- Use SQLite FTS5 for local full-text retrieval
- Use system `tesseract` for OCR first
- Default OCR mode to `screenshots`
- Use optional `exiftool` enrichment when available
- Delay semantic retrieval until after the baseline search engine is useful
- Keep the product local-first and privacy-first
- Keep system-level collectors for later phases

## Retrieval Strategy For Early V1

Start with:

- exact match
- fuzzy match
- full-text search
- OCR text search
- metadata filters
- recency-aware ranking

Add later:

- semantic retrieval
- richer project clustering
- timeline-aware reasoning

The practical priority right now is to preserve Phase 1 quality while moving into Phase 2 design and implementation.

## Phases

### Phase 1

- file and repo recall

### Phase 2

- work resurrection

### Phase 3

- machine actions

### Phase 4

- memory layer

### Phase 5

- agent interface via MCP or API

### Phase 6

- system-level deepening on Linux

## Most Important Docs

- [AI handoff](./00-AI-HANDOFF.md)
- [V1 machine search](./04-v1-machine-search.md)
- [Implementation spec](./09-v1-implementation-spec.md)
- [Data model](./10-data-model.md)
- [Decision log](./13-decision-log.md)

## Immediate Next Step

Begin Phase 1 of the v2 roadmap: daemon + MCP skeleton + `npx machine-memory init` install path. See `docs/23-product-v2-architecture.md` §7 for the phase scope and ship criteria, and `docs/06-roadmap-phases.md` for the sequencing.
