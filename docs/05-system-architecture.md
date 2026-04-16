# System Architecture

## Overview

The system should be layered.

Keep low-level observability thin and keep intelligence in user-space.

```text
Collectors
  -> Ingest pipeline
  -> Canonical event/file index
  -> Enrichment pipeline
  -> Retrieval engine
  -> Query/action interfaces
```

## Layer 1: Collectors

First version:

- filesystem crawler
- git repo scanner
- file metadata readers
- EXIF extractor
- OCR worker
- document text extractor

Later:

- live filesystem events
- process/file access events
- shell history ingestion
- browser history ingestion
- phone and app exports

## Layer 2: Canonical Index

Store normalized records for:

- files
- repos
- documents
- images
- directories
- machine events

Each record should have:

- stable ID
- path
- source type
- timestamps
- hashes where useful
- extracted text
- metadata
- tags
- relationships

## Layer 3: Enrichment

User-space enrichment should add:

- embeddings
- OCR text
- fuzzy aliases
- repo identity
- entity extraction
- inferred project clusters
- location hints
- time grouping

## Layer 4: Retrieval

Support mixed retrieval:

- keyword
- fuzzy path/name
- semantic search
- metadata filters
- time filters
- source filters
- reranking

## Layer 5: Interfaces

Interfaces should stay thin:

- CLI
- API
- MCP
- optional web UI

## Suggested Internal Modules

- `scanner`
- `index`
- `extractors`
- `ocr`
- `repos`
- `embeddings`
- `search`
- `ranking`
- `timeline`
- `mcp`
- `cli`

## Storage Model

Likely separate stores:

- metadata DB
- full-text index
- vector index
- cache/artifact directory

Keep the system modular so storage can evolve.

## Privacy And Trust

This product must be:

- local by default
- inspectable
- controllable by source
- explicit about what is indexed

Trust is a core feature, not a side concern.
