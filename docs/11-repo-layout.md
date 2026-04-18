# Repo Layout

## Goal

Keep the repository easy for humans and AI to navigate. The layout mirrors the product layers instead of mixing everything into one app folder.

## Current Structure (as of 2026-04-18, Phase 1 complete)

```text
machine-memory/
  README.md
  package.json
  tsconfig.json
  docs/                        — product, design, and phase docs (this folder)
  src/
    cli/
      main.ts                  — CLI entrypoint (commander)
      commands/
        scan.ts                — mm scan
        find.ts                — mm find
        show.ts                — mm show
        doctor.ts              — mm doctor
    config/
      defaults.ts              — default scan roots, exclude globs, paths
      loadConfig.ts            — user config file resolution
      paths.ts                 — XDG-style config/data paths
      types.ts                 — OcrMode, MachineMemoryConfig
    scanner/
      fileScanner.ts           — fast-glob crawl + batched DB commits
    repos/
      gitRepoScanner.ts        — git repo discovery and remote extraction
    extractors/
      textExtractor.ts         — markdown/plain/package-manifest/PDF/DOCX
    media/
      imageMetadata.ts         — EXIF + screenshot detection
    ocr/
      imageOcr.ts              — tesseract wrapper
    index/
      db.ts                    — SQLite + WAL open
      schema.ts                — tables and FTS5 virtual table
      textBlobs.ts             — upsert/hasTextBlob helpers
    search/
      find.ts                  — ranker, FTS, fuzzy, stop-word + stem
      queryParser.ts           — query normalization and source hints
    output/                    — pretty-printing helpers
    system/
      binaries.ts              — `which <bin>` detector
    types.ts                   — shared SearchResult shape
  tests/
    unit/                      — vitest suites, 36 tests
```

## Module Intent

### `cli/`
Command parsing and user-facing flows. The CLI is thin — each command is a small file that calls into the modules below.

### `config/`
Scan roots, ignore rules, OCR mode, storage paths. User config at `~/.config/machine-memory/config.json`, data at `~/.local/share/machine-memory/machine-memory.sqlite`.

### `scanner/`
Filesystem crawling via fast-glob, batched DB writes (default 500 files per transaction), incremental fingerprint cache, progress streaming.

### `repos/`
Git repo detection, remote URL parsing, last-commit time extraction.

### `extractors/`
Text body extraction for markdown, plain text, package manifests, PDFs (via `pdftotext` / `mutool` / built-in fallback), and DOCX (via `unzip -p word/document.xml` + XML strip).

### `media/`
Image metadata via optional `exiftool`, screenshot detection by filename heuristics.

### `ocr/`
Tesseract subprocess wrapper with bounded output.

### `index/`
SQLite open and schema. FTS5 virtual table over text blobs. Helpers for blob upsert and existence checks.

### `search/`
Ranker: file-name match, path match, FTS (strict-AND + OR), fuzzy (per-token for multi-word queries, whole-query for single-word typos), stop-word filter, plural-s soft stemming, source-hint scoring, path-quality penalty/bonus.

### `output/`
Shared pretty-printing for CLI results; will become a pair of serializers (CLI + MCP JSON) in Phase 5 per `docs/22-phase-2-research.md` F-012.

### `system/`
Thin wrappers over external binaries (`which`).

## Planned Additions

Modules that do not exist yet and the phase that will add them:

- `src/activity/` — activity ingesters (file-scanner hook, git-reflog, shell-history, screenshot-timestamps). Lands in Phase 2. See `docs/22-phase-2-research.md` §2.
- `src/mcp/` — MCP server exposing `mm_find` and `mm_get` tools. Lands in Phase 5. See `docs/22-phase-2-research.md` §3.
- `src/embeddings/` and/or `sqlite-vec` integration — semantic retrieval. Deferred per D-011 until the FTS-miss corpus justifies it. See `docs/22-phase-2-research.md` §6.

## Documentation Pattern

Each major module should eventually carry a short `README.md` with inputs, outputs, invariants, and an example flow. Not blocking for Phase 2 — add as each module gets its first significant refactor.
