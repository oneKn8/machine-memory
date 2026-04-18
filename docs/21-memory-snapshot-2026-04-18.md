# Memory Snapshot — 2026-04-18

This file is a dated project memory checkpoint.

Open this first when you want the shortest path back into the project without rereading the whole doc set.

## Project Identity

- product name: `Machine Memory`
- current stage: Phase 0 (substrate) shipped; v2 Phase 1 (daemon + MCP + one-line install) is next
- current mode: pivoted from staged per-feature ship to one unified always-on product; see [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) and D-019

## Core Shape

Machine Memory is:

- `mmd` — a local always-on daemon (systemd --user on Linux, launchd later)
- `mm` — a thin human CLI, MCP client over Unix socket to `mmd`
- an embedded MCP server inside `mmd` exposing `mm_find`, `mm_get`, `mm_recent`, `mm_chat`, `mm_subscribe`
- installed via `npx machine-memory init`

Five index tiers in one SQLite file:

1. FTS5 lexical
2. sqlite-vec semantic (opt-in)
3. entity + relationship graph
4. LLM-compiled markdown wiki (Karpathy-style, Obsidian-compatible)
5. activity_events chronological stream

Two consumers, one substrate. **Agents first, humans second** (D-018). The daemon is always watching; the MCP server is always reachable.

## The North Star

Make a computer remember everything, and make that memory usable — instantly, privately, and efficiently — for both the human who owns it and for any AI the human works with. See [`01-product-thesis.md`](./01-product-thesis.md).

## Origin

This project did **not** begin as a search product.

It began as a much larger multi-agent research-lab idea with many agents, a coordinating brain, nonstop experiments, and deep discovery loops. The project pivoted because machine-memory/search exposed a sharper and more immediate pain, and then the pivot sharpened again when "agent-first, one-line installable, always-on" replaced the staged-phase framing.

The original ambition survives: the v2 substrate is the grounding layer for agents and agent swarms.

## What Is True Right Now

Phase 0 is shipped:

- CLI commands for `scan`, `find`, `show`, `doctor`
- repo + file crawling
- PDF + DOCX + markdown + plain text extraction
- screenshot/image OCR + EXIF
- SQLite + FTS5 indexing with grounded provenance
- typo-tolerant repo recall
- incremental rescans with extraction-state healing (D-017)
- batched commits + progress streaming + F-009 pragma tuning (~9× throughput)
- real machine-grounded validation (91/93 PDFs, 13/14 DOCX indexed on the actual local machine)

## Recent Important Truths

These are the facts future work should respect:

1. **Phases are layers of one product, not separate products (D-019).** Every phase from Phase 1 onward ships the same daemon + CLI + MCP server, progressively more complete. Do not treat "old Phase 2" or "old Phase 5" as independent work.

2. **Agents first (D-018).** MCP is the primary surface. The CLI is the same tools, pretty-printed. Every design decision is evaluated against the agent path AND the human path.

3. **One-line installable is a hard constraint.** `npx machine-memory init` must Just Work on a clean Linux machine. External binaries are graceful optionals. `better-sqlite3` and `chokidar` must have prebuilt binaries for the target platform.

4. **The LLM compiler is off by default.** Respects D-002 (local-first). User opts in to `local` or `api` backend explicitly. Daemon is fully useful without it.

5. **F-010 (scheduled scans) and F-011 (scan-time delete/rename) are closed.** The daemon's real-time watcher replaces both.

6. **F-009's follow-up (extraction out of transaction + worker pool) is alive.** It lands in v2 Phase 1 — the daemon needs parallel extraction to keep up under realtime load.

7. **Doc 22 (Phase 2 research) is preserved as technical reference.** Its specific content is still primary: activity events schema, MCP tool schemas, SQLite pragma tuning (shipped), rename detection algorithm, sqlite-vec analysis. Only the staged-phase framing around it was superseded.

8. **The product is most believable when every answer explains why it matched.** Trust is not optional (D-005). The MCP interface inherits this: every result carries structured provenance.

9. **Semantic retrieval is intentionally deferred.** sqlite-vec is the chosen path; it lands when the wiki layer gives it a pre-compiled substrate to embed over. Until then, FTS5 + keyword + fuzzy is enough.

## What Comes Next

v2 Phase 1 — daemon skeleton + MCP server + `npx machine-memory init`. Scope and ship criteria in [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) §7 and [`docs/06-roadmap-phases.md`](./06-roadmap-phases.md).

Three decisions that gate code (each with a proposed default):

- **D-1** LLM compiler default: `off` (user enables local or api explicitly)
- **D-2** Daemon host: `systemd --user` on Linux
- **D-3** MCP registration: prompt per detected agent tool, never silent write

All three are written up in doc 23 §8 with rationale. Confirm or override before Phase 1 code starts.

## Best Re-entry Path

If you are resuming work later, read in this order:

1. [Current state](./15-current-state.md)
2. [**Product v2 architecture — canonical**](./23-product-v2-architecture.md)
3. [Roadmap phases](./06-roadmap-phases.md)
4. [Product thesis and north star](./01-product-thesis.md)
5. [Phase 2 research (technical reference)](./22-phase-2-research.md)
6. [Decision log](./13-decision-log.md) — especially D-017, D-018, D-019
7. [Phase 0 validation](./19-phase-1-validation.md)
8. [AI handoff](./00-AI-HANDOFF.md) — last, as reinforcement

## Practical Command Baseline

Use these to reorient:

```bash
cd /home/oneknight/projects/machine-memory
git status --short
git log --oneline -15
npm test
npm run typecheck
npm run build
npm run doctor
```

## Memory Principle

If a project idea, pivot, product truth, or implementation lesson matters, it should live in the repo as Markdown.

Do not trust chat history alone.
