# Roadmap Phases

## Trajectory

Each phase extends the same retrieval substrate toward the north star: a memory layer that serves both the human and the AI tools the human works with.

- Phases 1–2 make the machine answer human recall questions well ("where is that file?", "what was I doing?").
- Phases 3–4 turn recall into action and long-term memory across thoughts, work, and files.
- Phase 5 exposes the same substrate to AI agents so they reason on top of grounded, pre-filtered context instead of blindly crawling the machine.
- Phase 6 deepens the substrate with live system-level awareness once the product already has demand.

The thing we are building is the same substrate throughout. The human interface ships first because it is the fastest way to prove the retrieval layer is actually good.

## Phase 1: File And Repo Recall

Goal:

- Solve "where is that file/repo/image/document?"

Build:

- crawler
- metadata index
- repo scanner
- OCR for screenshots/images
- exact search
- fuzzy search
- full-text search
- metadata-aware ranking
- CLI

Ship when:

- vague queries work consistently for local files and repos

## Phase 2: Work Resurrection

Goal:

- Answer "what was I doing?"

Build:

- recent activity model
- time filters
- repo and project grouping
- local history stitching
- semantic retrieval where it clearly improves recall

Ship when:

- user can recover recent workstreams by timeframe or project

## Phase 3: Machine Actions

Goal:

- Turn retrieval into action

Build:

- open file
- reveal in file manager
- open repo in editor
- show related items
- save collections and pins

Ship when:

- the system is faster than manual recovery

## Phase 4: Memory Layer

Goal:

- Let the machine remember more than paths

Build:

- daily log ingestion
- note ingestion
- concept and project clustering
- long-term memory records

Ship when:

- user can search thoughts, work, and files together

## Phase 5: Agent Interface

Goal:

- Become the context substrate that decides what an AI sees before it thinks
- Replace blind `grep`/`glob`/file-read loops with grounded, pre-filtered retrieval so AI agents stop wasting tokens exploring the machine

Build:

- MCP server
- machine-aware retrieval API
- grounded query responses for other agents
- provenance surfaces so agents can cite evidence instead of hallucinating

Ship when:

- agents can query machine memory safely and usefully, and the output is better context than they would have gathered on their own

## Phase 6: System-Level Deepening

Goal:

- Move from snapshot indexing to live machine awareness

Build:

- filesystem event streams
- richer process context
- near-real-time updates
- Linux-native observability

Ship when:

- the product already has demand and the deeper infrastructure is justified
