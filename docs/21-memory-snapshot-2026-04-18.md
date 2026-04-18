# Memory Snapshot — 2026-04-18

This file is a dated project memory checkpoint.

Open this first when you want the shortest path back into the project without rereading the whole doc set.

## Project Identity

- product name: `Machine Memory`
- current stage: Phase 1 complete
- current mode: preserve Phase 1 as a stable baseline while preparing Phase 2

## Core Thesis

Machine Memory is a local-first answer engine for a machine.

The first product is not "AI for everything."
The first product is:

- search by memory
- grounded recall
- local trust

The pain it solves first is:

- "Where the hell is that file?"

The long-term direction remains much larger:

- work resurrection
- timeline reconstruction
- deeper second-brain memory
- agent-facing machine context
- eventually deeper Linux/system-level observability

## Origin

This project did **not** begin as a search product.

It began as a much larger multi-agent research-lab idea:

- many agents
- a main coordinating brain
- nonstop experiments
- deep discovery loops

The project pivoted because machine-memory/search exposed a sharper and more immediate pain.

That origin still matters:

- we are building a machine memory substrate now
- but the long-term system ambition is still much deeper than simple file search

## What Is True Right Now

Phase 1 is done.

That means the repo already has:

- CLI commands for `scan`, `find`, `show`, and `doctor`
- repo discovery
- file crawling
- PDF text extraction
- screenshot/image OCR
- image metadata extraction
- SQLite + FTS5 indexing
- typo-tolerant repo recall
- incremental rescans
- grounded result explanations

It also has real machine-grounded validation, not just mocked tests.

## Recent Important Truths

These are the facts future work should respect:

1. Phase 1 was completed honestly, not prematurely.
   It was reopened to fix search/ranking/extraction/perf gaps, then closed again with validation.

2. The scanner no longer holds one huge transaction across the whole root.
   It commits in batches and reports progress.

3. Full-root scans are still slower than pre-batching because of per-batch fsync cost (F-009). The fix is a small set of SQLite pragmas and is the first Phase 2 prep action — see `docs/22-phase-2-research.md` §1.

4. The product is most believable when every answer explains why it matched. Trust is not optional here.

5. Semantic retrieval is still intentionally deferred. `docs/22-phase-2-research.md` §6 names `sqlite-vec` as the chosen path when the time comes, with Anthropic's contextual-retrieval numbers as the target.

6. AI agents are a first-class user of Machine Memory, not a downstream Phase 5 integration. Every design decision is evaluated against both paths (human recall + agent grounding). See D-018 and `docs/01-product-thesis.md`.

7. Phase 2 has a concrete plan on disk: new `activity_events` table with typed `kind`, denormalized `subject_path`, JSON `data`; ingesters in order file-scanner → git-reflog → shell-history → screenshot timestamps. Ship criterion: 8/10 vague time-scoped queries return the right answer in top 3. See `docs/22-phase-2-research.md` §2.

## Current Frontier

The next frontier is Phase 2.

Phase 2 means:

- work resurrection
- time-aware activity indexing
- project/session continuity
- better answers to:
  - "What was I doing?"
  - "What was I working on last night?"
  - "Bring me back to the thing before this thing."

Important constraint:

- do not break Phase 1 while chasing Phase 2

## Best Re-entry Path

If you are resuming work later, read in this order:

1. [Current state](./15-current-state.md)
2. [Product thesis and north star](./01-product-thesis.md)
3. [Phase 2 research and F-009 plan](./22-phase-2-research.md)
4. [Phase 1 validation](./19-phase-1-validation.md)
5. [Phase 1 followups](./20-phase-1-followups.md)
6. [Decision log](./13-decision-log.md) — especially D-017 and D-018
7. [AI handoff](./00-AI-HANDOFF.md) — last, as reinforcement

## Practical Command Baseline

Use these to reorient:

```bash
cd /home/oneknight/projects/machine-memory
git status --short
git log --oneline -10
npm test
npm run typecheck
npm run build
npm run doctor
```

## Memory Principle

If a project idea, pivot, product truth, or implementation lesson matters, it should live in the repo as Markdown.

Do not trust chat history alone.
