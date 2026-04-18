# Machine Memory

A local-first memory engine for a personal computer. It decides what context gets seen before any thinking happens — for the human who owns the machine and for any AI the human works with.

The machine already has everything: files, repos, screenshots, PDFs, downloads, notes, recent work. What it lacks is retrieval that actually finds things when you only remember fragments. Machine Memory is that retrieval layer.

Two consumers, same substrate:

- **You**, asking "where is that PDF about quantization I read last month?" or "what repo was that called, `gitinsteroid` or something?"
- **Any AI agent on your machine**, today burning tokens on blind `grep`/`glob`/file-read loops, tomorrow asking Machine Memory for the small grounded set of files that actually matter to its task.

The retrieval layer is the same. The output shape differs. The machine finally remembers, for both of you.

## What it does today

Phase 1 ships file, repo, PDF, DOCX, screenshot, and image recall over a local SQLite+FTS5 index with grounded provenance on every answer. Real queries that work on a real machine:

```
$ mm find "gitinsteroid"
1. gitonsteroid
   type: repo
   path: /home/oneknight/zCoursework/gitonsteroid
   why: Matched similar repo name (91% similarity) and remote URL

$ mm find "Scanned 20 MCP Server Configs for Security Vulnerabilities"
1. Screenshot from 2026-04-01 19-07-04.png
   type: file
   path: /home/oneknight/Pictures/screenshots/...
   why: Matched screenshot OCR text: … the trenches.
        [Scanned] [20] [MCP] [Server] [Configs] for [Security] [Vulnerabilities] …

$ mm find "stat hw"
1. stat hw6.md             (markdown body + filename)
2. Stat hw 3.docx          (DOCX body + filename)
3. STAT HW 2 QUESTIONS SET.pdf  (PDF body + filename)
```

Every result explains *why* it matched — filename, path, PDF body, DOCX body, OCR, image metadata, or fuzzy similarity. That's D-005 in the decision log: grounded retrieval is the trust feature.

Validated against the real local machine, not fixtures: 91 of 93 indexed PDFs and 13 of 14 DOCX files carry extracted text blobs after the Phase 1 reopen. See [docs/19-phase-1-validation.md](./docs/19-phase-1-validation.md).

## Quick start

Requires Node.js ≥ 20. Optional external tools for richer extraction: `pdftotext` (poppler-utils), `unzip`, `tesseract`, `exiftool`, `git`.

```bash
git clone https://github.com/oneKn8/machine-memory.git
cd machine-memory
npm install
npm run build

# verify external tools
npm run doctor

# index configured roots (first time ~1-2 minutes per 10k files)
npm run scan

# or scan a specific root with screenshot OCR on
npm run scan -- --root ~/Pictures --ocr-mode screenshots

# search
npm run find -- "a book about stats"
npm run find -- "image from Colorado"

# inspect one result
npm run find -- "stat hw"           # copy an id from the output
npm run dev -- show <id>
```

Config lives at `~/.config/machine-memory/config.json`, index at `~/.local/share/machine-memory/machine-memory.sqlite`. Both are inspectable; the index is just SQLite.

## How it works

```
your files           extractors         index              retrieval
──────────           ──────────         ─────              ─────────
repos     ─┐        ┌ pdftotext ─┐     ┌ file_records ┐   ┌ stop-words ─┐
files     ─┼─► scan ┼ unzip      ┼──►  │ repo_records │   │ soft stem   │
PDFs      ─┤        ┼ tesseract  ┤     │ text_blobs   │◄──┤ strict FTS  │
screenshots┼        ┼ exiftool   ┤     │ text_blobs_  │   │ fuzzy       │
DOCX      ─┘        └ markdown   ┘     │   _fts (FTS5)│   │ rank + prov │
                                       └──────────────┘   └──────┬──────┘
                                                                 │
                                                          ┌──────▼──────┐
                                                          │ `mm find`   │ (human)
                                                          │ MCP tools   │ (AI, Phase 5)
                                                          └─────────────┘
```

Ranker merges five candidate pools (filename, path, repo, full-text, fuzzy) and scores each with word-boundary name match, FTS strict-AND confidence, source-hint boosts, and path-quality penalties for vendor/dist/build directories. Details in `src/search/find.ts`.

## Design principles

- **Local by default.** Nothing leaves the machine. No telemetry.
- **Grounded.** Every result explains why it matched (D-005). Phase 5's agent interface uses the same provenance surface so AI answers can cite evidence.
- **Inspectable.** The index is a SQLite file you can open with any SQLite tool.
- **Useful before magical.** Exact/fuzzy/full-text/OCR first. Semantic retrieval (planned via `sqlite-vec`) waits until the FTS-miss corpus justifies it (D-011).
- **Honest about scope.** If Phase 1 says "where is that file?" and not "what was I doing last Tuesday?", we ship Phase 1 and label Phase 2 as next.

## Where it's going

Six phases in [docs/06-roadmap-phases.md](./docs/06-roadmap-phases.md):

| Phase | Goal | Status |
|-------|------|--------|
| 1. File and repo recall | "where is that thing?" | **shipped** |
| 2. Work resurrection | "what was I doing?" | next — see [docs/22-phase-2-research.md](./docs/22-phase-2-research.md) |
| 3. Machine actions | retrieval → open/reveal/pin | planned |
| 4. Memory layer | thoughts + work + files together | planned |
| 5. Agent interface | MCP server, grounded context for AI | planned |
| 6. System-level | inotify/fanotify live indexing | parked until demand |

Phase 5 is the payoff of the north star. When it lands, any agent running on this machine can call `mm_find` over MCP and get a small grounded result set with citations — instead of burning its context window on blind file crawls.

## Read next

Start here, in order:

1. [Product thesis — the north star](./docs/01-product-thesis.md)
2. [Current state — what's actually true right now](./docs/15-current-state.md)
3. [Phase 2 research and F-009 plan](./docs/22-phase-2-research.md)
4. [Decision log](./docs/13-decision-log.md) — especially D-005 (grounded), D-011 (semantic delay), D-017 (fingerprint vs extraction), D-018 (AI as first-class user)
5. [Phase 1 validation](./docs/19-phase-1-validation.md) — what got validated and what had to be reopened
6. [Competitive landscape](./docs/14-competitive-landscape.md) — why nobody else ships this

Full doc index lives under [`docs/`](./docs/).
