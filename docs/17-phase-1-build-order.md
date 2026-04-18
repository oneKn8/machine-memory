# Phase 1 Build Order

**Status:** historical. Every step below shipped. Preserved as the record of how Phase 1 was sequenced. For the honest outcome (including items that had to be reopened after initial close), see `docs/18-phase-1-completion-checklist.md` and `docs/19-phase-1-validation.md`.

This file translates the Phase 1 plan into a practical implementation order.

## Step 1: Repository Spine

Create:

- git repository
- package.json
- tsconfig.json
- CLI entrypoint
- basic source layout

## Step 2: Metadata Storage

Build:

- SQLite database creation
- schema for file and repo records
- FTS5 table for extracted text

## Step 3: Repo Discovery

Build:

- scan configured roots
- support one-off root overrides for nonstandard machine layouts
- detect git repos
- read repo names and remotes
- store repo records

## Step 4: File Discovery

Build:

- crawl files under configured roots
- store file metadata
- ignore noisy paths like `.git` and `node_modules`

## Step 5: Retrieval Baseline

Build:

- exact file/path match
- fuzzy file/path match
- basic result formatting

## Step 6: Text Extraction

Build:

- README and manifest extraction
- plain-text and Markdown extraction
- PDF extraction
- FTS-backed search

## Step 7: OCR

Build:

- screenshot OCR
- image OCR
- OCR-backed retrieval

## Step 8: Ranking And Trust

Build:

- recency-aware ranking
- source-type weighting
- grounded result explanations

## Step 9: Validation

Verify:

- repo recall works
- screenshot OCR works
- PDF recall works
- result quality feels trustworthy on real local data

## Step 10: Polish

Add:

- exclusions
- `mm doctor`
- better output
- fixture coverage
