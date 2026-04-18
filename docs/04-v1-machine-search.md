# V1: Where The Hell Is It

**Status:** shipped as Phase 1 (2026-04-17). This doc is preserved as the original spec; all scope items below are implemented. For what is actually true now, see `docs/15-current-state.md`. For what got reopened and revalidated after first close, see `docs/19-phase-1-validation.md`.

## Goal

Ship a meaningful first product that solves one painful problem extremely well:

- help the user find something they know exists but cannot locate

## V1 Scope

Index the following local sources:

- files and directories
- git repos
- git remotes
- README and package metadata
- PDFs and plain documents
- screenshots
- images with EXIF metadata
- OCR text from images and screenshots
- downloads
- recent modification times

## V1 Query Types

- "Where is gitonsteroid?"
- "Find the image I took in Colorado."
- "Show me the screenshot I took while debugging MCP."
- "Find the PDF about quantization."
- "Which repo is tied to this GitHub remote?"
- "Find the movie file I downloaded last month."

## V1 Output Requirements

Every result should explain:

- what matched
- why it matched
- the local path
- last modified time
- related repo or project if known

## V1 Surfaces

### CLI

The first-class interface.

Examples:

```bash
mm find "where is gitonsteroid"
mm find "image from Colorado"
mm find "pdf about quantization"
```

### API / MCP

Second interface after the CLI works.

This lets other AI tools query machine memory.

## V1 Non-Goals

- full timeline UI
- phone sync
- kernel collectors
- autonomous agents
- graph visualization
- global app integration

## Why This Wedge Is Right

- obvious pain
- easy to demo
- valuable immediately
- local-first
- expands naturally into the larger vision

## Retrieval Strategy

V1 should start with:

- exact path and name matching
- fuzzy matching
- full-text search
- OCR-backed search
- metadata-aware ranking

Semantic retrieval can be added after the baseline search engine is strong.
