# V1 Implementation Spec

**Status:** delivered as Phase 1 (2026-04-17). This doc is the original spec; treat it as historical. For actual module layout see `docs/11-repo-layout.md`; for what shipped and what was validated see `docs/15-current-state.md` and `docs/19-phase-1-validation.md`.

## V1 Objective

Build a local-first CLI tool that can answer vague search queries about:

- repos
- files
- PDFs
- screenshots
- images
- downloads

The first release should reliably answer:

- "Where is that thing?"

Recommended implementation stack for V1:

- TypeScript
- Node.js
- SQLite
- SQLite FTS5
- system `tesseract` for OCR
- optional `exiftool` for richer image metadata

## User Stories

### Repo Recall

- As a developer, I want to find a local repo from a fuzzy memory of its name.
- As a developer, I want to map a GitHub remote back to a local clone.
- As a developer, I want to find repos by topic, README text, or package metadata.

### File Recall

- As a user, I want to find a document I remember by subject, not filename.
- As a user, I want to find a downloaded file by approximate time and type.
- As a user, I want to find a screenshot by what was visible in it.

### Image Recall

- As a user, I want to find an image by place or event.
- As a user, I want to find an image by OCR text or metadata.

## First Commands

```bash
mm scan
mm scan --root /path/to/other/workspace
mm scan --root /path/to/screenshots --ocr-mode screenshots
mm find "where is gitonsteroid"
mm find "image from Colorado"
mm find "pdf about quantization"
mm show <result-id>
```

Possible later commands:

```bash
mm open <result-id>
mm related <result-id>
mm doctor
```

## V1 Functional Requirements

### Scanning

- Crawl configured roots
- Support per-run root overrides for nonstandard machine layouts
- Support explicit OCR modes (`off`, `screenshots`, `all`)
- Detect git repos
- Extract repo remotes and metadata
- Index common file metadata
- Extract text from supported documents
- Extract OCR text from screenshots and images
- Store enough data for fast local retrieval

### Search

- Support keyword queries
- Support fuzzy name matching
- Support source filters such as repo, image, pdf, screenshot
- Support time-aware ranking signals
- Return grounded result cards with rationale

For the earliest useful release, prioritize:

- exact match
- fuzzy match
- full-text search
- OCR text search
- metadata filters

Semantic retrieval should come after the baseline retrieval engine feels strong.

### Result Presentation

Each result should include:

- title or best label
- type
- absolute path
- why it matched
- last modified
- related repo or source if available

## V1 Non-Functional Requirements

- Local-only by default
- Works offline after models and OCR dependencies are installed
- Fast enough to feel interactive for queries
- Safe to rerun indexing
- Inspectable on disk

## Supported Sources In V1

- local files
- local directories
- git repos
- README files
- package manifests
- Markdown docs
- plain text docs
- PDFs
- screenshots
- image metadata
- downloads

## Deferred From V1

- browser history
- terminal history
- daily logs
- phone logs
- event streaming
- process observability
- agent workflows
- graph UI

## Ranking Strategy

Blend these signals:

- exact path/name match
- fuzzy alias match
- recency
- source-type fit
- repo/project affinity
- OCR/text hit quality

Semantic similarity is a later signal, not a day-one requirement.

## Acceptance Criteria

V1 is good enough when:

- the tool can find a local repo from an imperfect name
- the tool can find screenshots by OCR text
- the tool can find PDFs by topic
- the tool can find an image by metadata, OCR, or filename cues from real local content
- results explain themselves clearly enough to trust

## Suggested First Milestones

### Milestone 1

- repo crawler
- file metadata DB
- exact and fuzzy search

### Milestone 2

- document text extraction
- screenshot OCR
- SQLite FTS5-backed text search
- better result cards

### Milestone 3

- semantic retrieval if needed
- mixed ranking
- `show` command

### Milestone 4

- polish
- exclusions
- scan config
- demo queries that work reliably
