# Open Questions

Questions that still need a call. When a question gets a decision, move it to `docs/13-decision-log.md` and delete it from here.

## Product Questions

- How much "AI" language should appear in external positioning versus plain search language? The north star (see `01-product-thesis.md`) names both human and AI consumers, but that is an internal framing, not a public tagline.
- Should there be a minimal local web UI in addition to the CLI, or does the CLI + future MCP cover the meaningful surfaces? The CLI-first call is locked (D-004), but web UI is unresolved.

## Technical Questions

- How should the system handle duplicate files (same sha256, different paths) and duplicate repos (same remote, different clones)? F-011 (sha256 column + rename detection) gets us the raw signal. The UX call — show all, dedupe, or cluster — is open.
- When Phase 2 activity ingesters land, what is the correct staleness policy for each source (e.g., how far back do we read shell history; do we re-ingest git reflog on every scan or only diff)?

## Privacy Questions

- What is the default policy when Phase 5 exposes the index over MCP to a local agent? D-002 locks local-first, but "any agent running on this machine gets the whole index" is a real design choice that has not been made. Allowlist? Per-path ACL? All-or-nothing?
- Shell history is an explicit opt-in per `docs/22-phase-2-research.md` §2. What about browser history and clipboard history when they eventually land in Phase 4? Opt-in by source, opt-in per directory, or prompt-on-first-index?

## Scope Questions

- Linux-only for the foreseeable future, or does macOS/Windows land inside Phase 3 or 4? Currently Linux-first per D-004 but never formalized as Linux-*only*.
- Phase 2 ship criterion is "8/10 vague time-scoped queries return the right answer in top 3" (per `docs/22-phase-2-research.md` §2). Is that the right grading bar, or should it be stricter before calling Phase 2 done?

## Naming Notes

Working product name: Machine Memory.

Alternative framings worth remembering in case we revisit:

- Machine SEO / Machine AEO
- Personal answer engine
- Memory layer for your machine

## Already Decided (Cross-Reference)

Questions that used to live here and are now answered:

- First audience → D-004 (developers / Linux power users first).
- Implementation stack → D-009 (TypeScript + Node.js), D-010 (SQLite + FTS5).
- Default ranking blend → D-014, D-015, D-017; see also ranker in `src/search/find.ts`.
- Indexed directories by default → `src/config/defaults.ts` and `docs/12-ingest-sources.md`.
- Node libraries for extraction and OCR → D-013 (exiftool optional), plus shipped choices: `pdftotext`, `unzip`, `tesseract`, `fast-glob`, `better-sqlite3`.
- Sensitive-path exclusion mechanism → shipped: `DEFAULT_EXCLUDE_GLOBS` + per-root override via config or `--exclude`.
- Telemetry acceptability → D-002 (local-first, privacy-first). Answer: none.
- Embedding storage when we get there → `docs/22-phase-2-research.md` §6 (sqlite-vec alongside FTS5).
- When does MCP land → Phase 5 per `docs/06-roadmap-phases.md`; concrete tool surface already specified in `docs/22-phase-2-research.md` §3.
- When does system-level / kernel observability land → Phase 6 per roadmap; D-003 keeps it explicitly late.
