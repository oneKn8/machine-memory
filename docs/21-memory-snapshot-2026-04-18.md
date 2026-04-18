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

2. Full-root scans can still be expensive.
   This is acceptable for now because OCR is explicit and controllable.

3. The scanner no longer holds one huge transaction across the whole root.
   It commits in batches and reports progress.

4. The product is most believable when every answer explains why it matched.
   Trust is not optional here.

5. Semantic retrieval is still intentionally deferred.
   The baseline product should remain debuggable and grounded.

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
2. [Phase 1 validation](./19-phase-1-validation.md)
3. [Phase 1 followups](./20-phase-1-followups.md)
4. [Decision log](./13-decision-log.md)
5. [AI handoff](./00-AI-HANDOFF.md)

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
