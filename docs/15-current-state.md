# Current State

This file is a snapshot of what has already been decided and what the current direction is.

Use this when you want the fastest possible orientation.

## Working Name

- Machine Memory

## Core Product Idea

Build a private, local-first answer engine for a machine.

Important context:

- this project originally started from a different ambition: an autonomous multi-agent research lab
- the direction intentionally pivoted into machine memory and retrieval because it exposed a sharper, more immediate product pain
- the long-term technical horizon still includes deep Linux system integration and possibly near-kernel observability, but only after the search and memory product is real

The first pain it solves is:

- "Where the hell is that file?"

The larger vision is:

- search by meaning
- work resurrection
- timeline reconstruction
- long-term machine memory
- later, machine-aware context for AI agents

## V1 Wedge

The first version is a CLI-first local search tool for:

- repos
- files
- PDFs
- screenshots
- images
- downloads

It should help users recover things they know exist but cannot locate.

## Locked Early Decisions

- Use TypeScript for implementation
- Use Node.js for runtime
- Use SQLite for metadata storage
- Use SQLite FTS5 for local full-text retrieval
- Use system `tesseract` for OCR first
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

Turn the documentation into an actual repository and start implementing the Phase 1 scanner and index.
