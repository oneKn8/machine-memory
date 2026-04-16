# Roadmap Phases

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

- Expose machine memory to AI tools

Build:

- MCP server
- machine-aware retrieval API
- grounded query responses for other agents

Ship when:

- agents can query machine memory safely and usefully

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
