# AI Handoff

This file is the fastest way for any future AI or collaborator to understand the project.

For the fastest dated checkpoint, also read:

- [Memory snapshot (2026-04-18)](./21-memory-snapshot-2026-04-18.md)

## What This Project Is

Machine Memory is a local-first machine search and memory system.

Current working product name:

- `Machine Memory`

It is meant to help a user recover things they know exist but cannot locate, such as:

- files
- repos
- screenshots
- images
- PDFs
- downloads
- notes
- recent work

The larger vision is to turn a machine into a searchable memory substrate that understands:

- meaning
- time
- people
- places
- projects
- relationships

## What Problem We Are Solving First

The first problem is:

- "Where the hell is that file?"

This includes queries like:

- "Where is gitonsteroid?"
- "Find the image I took in Colorado."
- "Show me the PDF about quantization."
- "What repo was I working on before ruflo?"

## Phase 1 Status

Phase 1 is complete.

Working pieces already exist:

- CLI search and inspection
- repo discovery
- file crawling
- text extraction
- PDF extraction
- screenshot and image OCR
- metadata-backed image recall
- local SQLite + FTS5 retrieval

Phase 1 hardening is now in place:

- incremental scan caching with stable file fingerprints
- configurable exclusions and scan roots
- typo-tolerant repo recall and stronger mixed-source ranking
- provenance-rich `show` output
- real-world validation on actual local data and actual local repos

Use the completion checklist for the exact exit criteria:

- [Phase 1 completion checklist](./18-phase-1-completion-checklist.md)
- [Phase 1 validation notes](./19-phase-1-validation.md)

## What We Are Not Doing First

We are not starting with:

- kernel modules
- full life logging
- autonomous agents everywhere
- giant knowledge graph UIs
- cross-device syncing
- a generic AI assistant shell

Those may come later, but only after the first product is useful.

## Product Shape

The product should feel like:

- search by memory
- not search by filename

It should answer:

- what is it
- where is it
- why it matched
- what else is related
- when it mattered

## Why This Matters

People do not only lose files.
They lose retrievability.

The machine already has the data, but not the understanding.

## Current Wedge

The current wedge is:

- local machine search and recall for developer machines

Index:

- file paths and metadata
- git repos and remotes
- README and package metadata
- screenshots
- images with metadata and OCR
- PDFs and documents
- downloads
- recent activity

Deliver through:

- CLI first
- API or MCP second
- optional lightweight UI later

The next active frontier is Phase 2 design and implementation, but Phase 1 should remain the stable baseline for search quality and trust.

## Long-Term Vision

Build a private answer engine for a machine.

Later phases can expand into:

- project resurrection
- timeline reconstruction
- second-brain memory
- phone and daily log ingestion
- machine-level event streaming
- agent-facing machine context

## Reading Order

1. [Product thesis](./01-product-thesis.md)
2. [Problems and users](./02-problems-and-users.md)
3. [Current wedge](./04-v1-machine-search.md)
4. [Architecture](./05-system-architecture.md)
5. [Roadmap](./06-roadmap-phases.md)
6. [Implementation spec](./09-v1-implementation-spec.md)
7. [Data model](./10-data-model.md)
8. [Decision log](./13-decision-log.md)
9. [Current state](./15-current-state.md)
10. [Project history](./16-project-history.md)
11. [Memory snapshot (2026-04-18)](./21-memory-snapshot-2026-04-18.md)

## Origin Story

This project did not begin as a search product.

The original direction was a multi-agent research lab:

- many agents
- a main coordinating brain
- nonstop experiments
- deep research and discovery loops

During exploration, the direction shifted toward a more immediate and painful problem:

- users cannot reliably recover things they know are on their machines

That pivot produced the current product direction:

- Machine Memory

The long-term end state still points toward deep system integration on Linux, but the path now starts with machine search and recall rather than autonomous research agents.

## Current Principle

Start with a painful, obvious product.
Only deepen into system-level infrastructure after people already want the thing.
