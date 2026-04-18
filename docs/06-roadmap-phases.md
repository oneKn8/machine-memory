# Roadmap Phases

Phases are layers of **one product**, not independent ship frames. The canonical architecture is [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md). Each phase below ships the same daemon (`mmd`) + CLI (`mm`) + embedded MCP server, progressively more complete.

The north star is in [`docs/01-product-thesis.md`](./01-product-thesis.md): a local-first memory substrate that grounds humans and AI on the machine they share, installable in one line.

## Trajectory

- Phase 0 is the retrieval substrate (shipped).
- Phase 1 turns it into a daemon with an MCP server and one-line install. The shape of the product changes here; every later phase keeps that shape and fills layers.
- Phases 2–3 add the memory layers (activity, graph, LLM-compiled wiki).
- Phase 4 makes it conversational.
- Phase 5 ships it to more platforms.

Every phase evaluates against **both** consumers (D-018): does this make the human experience better, and does this make the agent grounding better?

## Phase 0 — Substrate (shipped)

Goal:

- Solve "where is that file/repo/image/document?" on real local content with grounded provenance.

Shipped:

- CLI `mm scan`/`find`/`show`/`doctor`
- SQLite + FTS5 index
- PDF, DOCX, markdown, and OCR extraction
- Ranker with stop-word filter, soft stemming, fuzzy recall, word-boundary bonus, FTS strict-AND confidence
- Incremental scan cache with extraction-state healing (D-017)
- Batched commits + progress streaming + F-009 pragma tuning (~9× throughput)
- Real-world validation against the actual local machine (91/93 PDFs, 13/14 DOCX, zero-regression proof queries)

Evidence:

- [`docs/19-phase-1-validation.md`](./19-phase-1-validation.md)
- [`docs/18-phase-1-completion-checklist.md`](./18-phase-1-completion-checklist.md)

## Phase 1 — Daemon + MCP Skeleton (next)

Goal:

- Turn the CLI tool into a local always-on memory daemon. One-line install. Agents as the primary consumer.

Build:

- `mmd` long-running daemon under `systemd --user`
- `chokidar`/inotify watcher with debounce and worker-pool extraction (F-009 follow-up lands here)
- Embedded MCP server exposing `mm_find`, `mm_get`, `mm_recent`
- `mm` CLI rewritten as thin MCP client over Unix socket
- `npx machine-memory init` installs the unit, prompts for MCP registration with detected agent tools, kicks off first scan
- `mm status` / `mm doctor` upgraded for daemon health

Ship when:

- `npx machine-memory init` on a clean Linux machine produces a working daemon, a registered MCP server Claude Code can call `mm_find` on, and live-indexing within 5 seconds of a file change
- Human `mm find "..."` hits the daemon and returns the same quality of results as Phase 0

## Phase 2 — Activity + Entity Graph

Goal:

- The substrate learns *when* and *how* things change, and how they relate.

Build:

- `activity_events` table + ingesters: file-scanner hook, git-reflog reader, screenshot mtime clustering. Shell history opt-in.
- Delete + rename detection via sha256 + path-set diff (per [`docs/22-phase-2-research.md`](./22-phase-2-research.md) §4). Emits first-class activity events.
- `entity_records` + `relationship_records` tables. Cheap deterministic edges first: file IN_REPO, git author AUTHORED_BY, file MENTIONS path.
- `mm_recent` upgraded to query activity events; ranker gains a recency signal.

Ship when:

- For 8/10 vague time-scoped queries ("what was I doing Tuesday?", "what did I touch on ruflo?"), the right answer is in top 3
- Deletes and renames on real machine data never leave ghost entries after 24 hours of daemon uptime

## Phase 3 — Wiki Compiler

Goal:

- The LLM-compiled knowledge layer (Karpathy's LLM Wiki adapted to a machine, not a research folder).

Build:

- Compiler loop in the daemon. Triggers on settled file change or activity burst.
- LLM (local or API per config) extracts entities, updates relationship edges, writes/updates markdown wiki pages under `~/.local/share/machine-memory/wiki/`.
- Wiki kinds: `projects/<slug>.md`, `concepts/<slug>.md`, `people/<slug>.md`, plus `index.md` (catalog) and `log.md` (chronological).
- Retrieval reads the wiki page first for known entities; falls through to T1/T2/T3 for the long tail.
- Contextual retrieval: prepend page front-matter context to chunks before embedding ([Anthropic, 35-67% failure reduction](https://www.anthropic.com/news/contextual-retrieval)).

Ship when:

- For a project with ≥20 files and ≥5 activity events, the auto-generated wiki page answers "what is this project about?" at a level the user confirms is accurate
- No manual wiki editing is required for the page to be useful

## Phase 4 — Conversational Surface

Goal:

- Humans stop typing commands. Agents already have this because they ARE conversational.

Build:

- `mm_chat` MCP tool with multi-turn dialogue memory scoped by agent id
- `mm chat` CLI as a REPL over that tool
- NL preprocessor: intent classification (search / recall / compile / act), entity + time extraction, follow-up resolution ("which one?", "the second", "open it")
- Backend: Claude via the compiler's existing `api` path (fastest ship) or a local small model (private, slower)

Ship when:

- A user can have a 5-turn dialogue with `mm chat` about a project they actually work on and every fact cites a file/entity/wiki page
- At least one follow-up ("the second one", "when was that?") resolves correctly

## Phase 5 — Cross-Platform + Polish

Goal:

- Make the product shippable beyond Linux and benchmark it at scale.

Build:

- macOS support: launchd plist instead of systemd unit, `fsevents` through chokidar, `~/Library/...` paths, Homebrew-friendly external binary fallbacks
- Windows support: larger port; background service model
- Benchmarks on 100k and 500k file corpora; worker-pool tuning; sqlite-vec performance sweep
- `mm doctor` diagnoses daemon health, MCP reachability, wiki staleness, extraction coverage

Ship when:

- `npx machine-memory init` on macOS meets the Phase 1 bar
- Benchmark on a 500k-file corpus completes initial scan in under 1 hour, steady-state CPU < 5% idle
