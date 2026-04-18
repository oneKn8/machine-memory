# Machine Memory

A local-first, always-on memory engine for a personal computer. It decides what context gets seen before any thinking happens — for the human who owns the machine and for any AI the human works with.

**The product:** a daemon (`mmd`) + thin CLI (`mm`) + embedded MCP server, installed with one line. Agents live on it. Humans dip in.

```bash
npx machine-memory init
```

The daemon watches your filesystem in real time, maintains a tiered index (lexical + semantic + knowledge graph + LLM-compiled wiki + activity stream), and exposes it over MCP to any agent on the machine. The CLI is a thin client over the same tools the agent calls. Everything runs locally.

Two consumers, one substrate:

- **You**, asking *"where is that PDF about quantization I read last month?"* or *"what was I working on before ruflo?"*
- **Any AI agent on your machine** — Claude Code, Cursor, local LLMs — today burning tokens on blind `grep`/`glob`/file-read loops. Tomorrow asking Machine Memory for the small grounded set of files that actually matter.

Same retrieval, two output shapes. The machine finally remembers, for both of you.

## Status — where we are

- **Phase 0 (shipped):** CLI-first retrieval substrate — FTS5 index, PDF/DOCX/OCR extraction, ranker with provenance.
- **Phase 1 (next):** turn the CLI tool into a daemon with an MCP server, shipped via `npx machine-memory init`.
- **Phases 2–5:** activity stream, knowledge graph, LLM-compiled wiki, conversational surface, cross-platform polish — all layers of the same daemon.

Phases are **layers of one product**, not independent ship frames. Canonical architecture: [`docs/23-product-v2-architecture.md`](./docs/23-product-v2-architecture.md). The pivot from staged ship to unified product is recorded as D-019 in [`docs/13-decision-log.md`](./docs/13-decision-log.md).

## What works today (Phase 0)

Every query returns grounded results with a "why matched" string. Real examples on a real machine:

```
$ mm find "gitinsteroid"
1. gitonsteroid
   type: repo
   path: /home/oneknight/zCoursework/gitonsteroid
   why: Matched similar repo name (91% similarity) and remote URL

$ mm find "Scanned 20 MCP Server Configs for Security Vulnerabilities"
1. Screenshot from 2026-04-01 19-07-04.png
   why: Matched screenshot OCR text: … the trenches.
        [Scanned] [20] [MCP] [Server] [Configs] for [Security] [Vulnerabilities] …

$ mm find "stat hw"
1. stat hw6.md             (markdown body + filename)
2. Stat hw 3.docx          (DOCX body + filename)
3. STAT HW 2 QUESTIONS SET.pdf  (PDF body + filename)
```

Validated against the real local machine — 91 of 93 indexed PDFs and 13 of 14 DOCX files carry extracted text after the Phase 1 reopen. See [`docs/19-phase-1-validation.md`](./docs/19-phase-1-validation.md).

## What we are building next (v2 Phase 1)

`mmd` — the daemon. `mm` — a thin MCP client over Unix socket. `npx machine-memory init` — the one-line install that bootstraps systemd user unit, prompts to register MCP with detected agent tools, kicks off first scan.

After v2 Phase 1 ships:

- Drop a PDF into `~/Downloads` → it's searchable within 5 seconds, no manual command
- Claude Code on the same machine calls `mm_find` over MCP and gets JSON results with citations instead of running blind `grep -r`
- You never run `mm scan` again

## Architecture at a glance

```
┌─ filesystem ───┐   inotify     ┌─ mmd (daemon) ──────────────────┐
│ ~/projects     │──── events ──▶│                                 │
│ ~/Downloads    │               │  extraction pool (worker threads)│
│ ~/Pictures     │               │  ↓                              │
│ …              │               │  tiered index in one SQLite file│
└────────────────┘               │   T1 FTS5 (lexical)             │
                                 │   T2 sqlite-vec (semantic)      │
                                 │   T3 entities + edges (graph)   │
                                 │   T4 wiki/*.md (LLM-compiled)   │
                                 │   T5 activity_events            │
                                 │  ↓                              │
                                 │  MCP server on Unix socket      │
                                 └──────┬──────────────────────────┘
                                        │
                 ┌──────────────────────┼─────────────────────┐
                 ▼                      ▼                     ▼
            ┌────────┐        ┌──────────────────┐   ┌────────────┐
            │   mm   │        │ Claude Code      │   │ Cursor,    │
            │ (human)│        │ Claude Desktop   │   │ local LLMs │
            └────────┘        └──────────────────┘   └────────────┘
```

Full component breakdown, schema, install contract, and phase ship criteria in [`docs/23-product-v2-architecture.md`](./docs/23-product-v2-architecture.md).

## Design principles

- **Local by default.** No telemetry. The compiler LLM backend is `off` on first install — user opts in explicitly to local model or API.
- **Grounded.** Every result explains why it matched. Phase 3's LLM-compiled wiki pages cite their source files the same way; agent answers stay citable.
- **Inspectable.** The index is a single SQLite file at `~/.local/share/machine-memory/`. The wiki is plain markdown at `~/.local/share/machine-memory/wiki/`, Obsidian-compatible.
- **Agents first, humans second.** MCP is the primary surface. The CLI is the same tools, pretty-printed for a terminal.
- **One-line installable.** `npx machine-memory init` bootstraps everything. External binaries (`pdftotext`, `unzip`, `tesseract`, `exiftool`) are graceful optionals — `mm doctor` reports missing ones; product degrades rather than fails.
- **Useful before magical.** FTS5 lexical retrieval is the default. Vector search, entity extraction, and wiki compilation are additive layers, not prerequisites.

## Read next

Start here, in order:

1. [Product thesis — the north star](./docs/01-product-thesis.md)
2. [**Product v2 architecture — canonical**](./docs/23-product-v2-architecture.md)
3. [Roadmap phases — layers of the v2 product](./docs/06-roadmap-phases.md)
4. [Decision log](./docs/13-decision-log.md) — especially D-005 (grounded), D-018 (agents first-class), D-019 (phase collapse)
5. [Phase 2 research — technical reference preserved through the pivot](./docs/22-phase-2-research.md)
6. [Phase 0 validation](./docs/19-phase-1-validation.md) — what the shipped substrate actually proves
7. [Competitive landscape](./docs/14-competitive-landscape.md) — why nobody ships this combination

Full doc index lives under [`docs/`](./docs/).
