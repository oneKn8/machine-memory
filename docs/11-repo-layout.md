# Proposed Repo Layout

## Goal

Keep the repository easy for humans and AI to navigate.

The layout should mirror the product layers instead of mixing everything into one app folder.

## Suggested Top-Level Structure

```text
machine-memory/
  README.md
  docs/
  src/
    cli/
    config/
    scanner/
    repos/
    extractors/
    ocr/
    embeddings/
    index/
    search/
    ranking/
    output/
    mcp/
    utils/
  tests/
    fixtures/
    integration/
    unit/
  scripts/
  data/
```

## Module Intent

### `cli/`

- command parsing
- user-facing CLI flows
- output formatting entry points

### `config/`

- indexed roots
- ignore rules
- storage config
- model and OCR settings

### `scanner/`

- filesystem crawling
- directory walking
- source discovery

### `repos/`

- git repo detection
- remote extraction
- branch and commit metadata
- manifest and README summaries

### `extractors/`

- PDF extraction
- text extraction
- EXIF readers
- general metadata adapters

### `ocr/`

- image OCR pipeline
- screenshot OCR handling

### `embeddings/`

- chunking
- embedding generation
- vector storage adapter

### `index/`

- metadata DB
- persistence adapters
- indexing state

### `search/`

- query parsing
- lexical retrieval
- semantic retrieval
- filters

### `ranking/`

- score blending
- reranking
- explanation generation

### `output/`

- result cards
- JSON output
- future TUI or API serializers

### `mcp/`

- later-phase MCP server
- tool exposure

## Suggested Documentation Pattern

Each major module should eventually have:

- a short `README.md`
- inputs
- outputs
- invariants
- example flow

This keeps future AI sessions from re-deriving architecture every time.
