# Machine Memory

Working concept for a local-first machine memory and answer engine.

Current working product name:

- `Machine Memory`

This project starts with a simple but painful problem:

- "Where the hell is that file?"

The long-term vision is much bigger:

- Search a machine by meaning, not just by filename
- Recover projects, files, images, notes, and work by memory, time, and context
- Build a private memory layer for a computer that both humans and AI agents can use

## Status

Phase 1 is complete.

The current baseline already supports:

- local repo recall
- file and document recall
- PDF text recall
- screenshot OCR recall
- image recall
- incremental rescans
- grounded `find` and `show` output

Validation notes:

- [Phase 1 completion checklist](./docs/18-phase-1-completion-checklist.md)
- [Phase 1 validation notes](./docs/19-phase-1-validation.md)

## Read This First

If you are a human or AI picking this up, start here:

1. [AI handoff](./docs/00-AI-HANDOFF.md)
2. [Memory snapshot (2026-04-18)](./docs/21-memory-snapshot-2026-04-18.md)
3. [Product thesis](./docs/01-product-thesis.md)
4. [Current wedge](./docs/04-v1-machine-search.md)
5. [Architecture](./docs/05-system-architecture.md)
6. [Roadmap](./docs/06-roadmap-phases.md)

## Document Map

- [00-AI-HANDOFF](./docs/00-AI-HANDOFF.md)
- [01-product-thesis](./docs/01-product-thesis.md)
- [02-problems-and-users](./docs/02-problems-and-users.md)
- [03-idea-backlog](./docs/03-idea-backlog.md)
- [04-v1-machine-search](./docs/04-v1-machine-search.md)
- [05-system-architecture](./docs/05-system-architecture.md)
- [06-roadmap-phases](./docs/06-roadmap-phases.md)
- [07-demo-queries](./docs/07-demo-queries.md)
- [08-open-questions](./docs/08-open-questions.md)
- [09-v1-implementation-spec](./docs/09-v1-implementation-spec.md)
- [10-data-model](./docs/10-data-model.md)
- [11-repo-layout](./docs/11-repo-layout.md)
- [12-ingest-sources](./docs/12-ingest-sources.md)
- [13-decision-log](./docs/13-decision-log.md)
- [14-competitive-landscape](./docs/14-competitive-landscape.md)
- [15-current-state](./docs/15-current-state.md)
- [16-project-history](./docs/16-project-history.md)
- [17-phase-1-build-order](./docs/17-phase-1-build-order.md)
- [18-phase-1-completion-checklist](./docs/18-phase-1-completion-checklist.md)
- [19-phase-1-validation](./docs/19-phase-1-validation.md)
- [20-phase-1-followups](./docs/20-phase-1-followups.md)
- [21-memory-snapshot-2026-04-18](./docs/21-memory-snapshot-2026-04-18.md)

## Current Direction

The first product is not "AI for everything on your machine."

The first product is:

- a private local answer engine for files, repos, images, documents, and recent work
- designed to answer vague human queries
- especially good at "I know I have it, but I forgot where it is"

## Working Positioning

Possible positioning lines:

- Search your computer by memory, not by filename.
- Ask your machine where things are.
- A private answer engine for your machine.
- A memory layer for your digital life.
