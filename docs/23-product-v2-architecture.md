# Product v2 Architecture — Machine Memory As An Always-On Substrate

**Dated:** 2026-04-18.

**Status:** Canonical. Supersedes the old staged-roadmap framing where each phase was treated as a semi-independent product. The phases remain — they are layers of the *same* product delivered in order.

**Inputs this doc synthesizes:**

- [`docs/01-product-thesis.md`](./01-product-thesis.md) — north star.
- [`docs/06-roadmap-phases.md`](./06-roadmap-phases.md) — phase names (rewritten to match this doc).
- [`docs/13-decision-log.md`](./13-decision-log.md) — D-001 to D-018; D-019 records the collapse captured here.
- [`docs/14-competitive-landscape.md`](./14-competitive-landscape.md) — what nobody else ships.
- [`docs/22-phase-2-research.md`](./22-phase-2-research.md) — SQLite pragmas, activity event schema, MCP tool surface, sqlite-vec for semantic. Preserved as primary technical research.
- Research on Karpathy's LLM Wiki, Microsoft GraphRAG, Mem0 state of AI agent memory 2026, Anthropic's Contextual Retrieval. Sources at the bottom.

---

## 1. What We Are Actually Building

A **local-first, always-on memory daemon** that indexes a personal computer continuously and exposes that memory to two consumers through two thin interfaces:

- **`mmd`** — the daemon. Runs continuously under `systemd --user` (Linux first). Watches configured roots via inotify, extracts content, maintains the tiered index, hosts an MCP server 24/7, and runs an LLM "compiler" loop that keeps the wiki layer current.
- **`mm`** — the human CLI. Thin client that speaks MCP to `mmd` over a Unix socket. The same tools the AI calls: `mm_find`, `mm_get`, `mm_recent`, `mm_chat`.
- **MCP server embedded in `mmd`** — the agent-facing surface. Any agent on the machine that speaks MCP (Claude Code, Cursor, local LLMs, future ones) gets a retrieval substrate that is already right, always current.

Installed with **one line**:

```bash
npx machine-memory init
```

…which bootstraps the daemon, generates the systemd user unit, registers the MCP server with any detected agent tools, and begins the first scan in the background.

**Order of consumers is explicit (D-018 elevated): agents first, humans second.** Agents live on the substrate 24/7. Humans dip in with `mm find` when the agent isn't available or when they want to bypass the agent. Both sides use the same MCP tools; the CLI is literally `mm` → MCP call → pretty-print.

---

## 2. Why The Phase Collapse Is Honest, Not Ambitious

The original roadmap (`docs/06-roadmap-phases.md`, pre-pivot version) treated six phases as independent ship frames. That framing worked when the product was "local search," because each phase added a *category* of answer: recall, activity, actions, memory, agents, realtime.

The end goal (per [`docs/01-product-thesis.md`](./01-product-thesis.md)) was always a single thing: **the substrate that grounds humans and AI on the machine they share**. A six-stage ship of separate slices paid a coordination cost each time, because every phase that shipped independently had to be partially rebuilt later to compose with the next one.

Collapsing means: **build the product shape first, then fill the layers in order**. Every phase from here ships the *same daemon + same CLI + same MCP server*, progressively more complete. An agent that could only call `mm_find` after Phase 1 can still call it after Phase 5; the tool's output just gets richer.

What we kept from the old phases:

- Activity events (old Phase 2) → **Layer: Clock**. The daemon needs it to know what changed and when.
- Entity/relationship graph + wiki (old Phase 4) → **Layer: Knowledge**. Why agents stop hallucinating about your machine.
- MCP server (old Phase 5) → **Primary surface**. Not a future integration, the first thing we ship after the daemon skeleton.
- Realtime indexing (old Phase 6) → **Daemon core**. This is what the daemon IS.

What dies:

- Staged shipping of separate CLI commands for each capability (`mm open`, `mm pin`, etc.). An agent with Bash and filesystem access doesn't need these — it already knows how to open a file once retrieval gives it the path. Humans call agents for this too.
- F-010 scheduled scans (from [`docs/20-phase-1-followups.md`](./20-phase-1-followups.md)). The daemon replaces it entirely.
- F-011 delete/rename detection as a scan-pass algorithm. The watcher gets deletes and renames as first-class events.

What stays:

- F-009 follow-up (extraction-out-of-transaction + parallel workers). The daemon needs it to keep up under realtime load.

---

## 3. System Shape

```
 ┌───────────────────────────────────────────────────────────────────┐
 │  your computer                                                    │
 │                                                                   │
 │  ┌─────────────────┐        ┌──────────────────────────────────┐  │
 │  │  filesystem     │  inotify│   mmd  (daemon)                  │  │
 │  │  ~/projects     │────────▶│                                  │  │
 │  │  ~/Downloads    │  events │   ┌─── extraction pool ────┐     │  │
 │  │  ~/Pictures     │         │   │ pdftotext unzip tess   │     │  │
 │  │  …              │         │   │ exiftool markdown …    │     │  │
 │  └─────────────────┘         │   └───────────┬────────────┘     │  │
 │                              │               │                  │  │
 │                              │   ┌──────── index tiers ────┐    │  │
 │                              │   │ T1  FTS5 (lexical)      │    │  │
 │                              │   │ T2  sqlite-vec (sem)    │    │  │
 │                              │   │ T3  entities + edges    │    │  │
 │                              │   │ T4  wiki/*.md (LLM)     │    │  │
 │                              │   │ T5  activity_events     │    │  │
 │                              │   └────────────┬────────────┘    │  │
 │                              │                │                 │  │
 │                              │   ┌─ LLM compiler loop ─┐        │  │
 │                              │   │ entity extraction   │        │  │
 │                              │   │ wiki page updates   │        │  │
 │                              │   │ (local or API)      │        │  │
 │                              │   └─────────────────────┘        │  │
 │                              │                                  │  │
 │                              │   ┌─ MCP server (Unix sock) ───┐ │  │
 │                              │   │ mm_find  mm_get  mm_recent │ │  │
 │                              │   │ mm_chat  mm_subscribe      │ │  │
 │                              │   └──────┬─────────────────────┘ │  │
 │                              └──────────┼───────────────────────┘  │
 │                                         │                          │
 │       ┌─────────────────────────────────┼─────────────────┐        │
 │       │                                 │                 │        │
 │       ▼                                 ▼                 ▼        │
 │  ┌────────┐                   ┌────────────────┐   ┌────────────┐  │
 │  │   mm   │  (human CLI,      │ Claude Code    │   │ Cursor,    │  │
 │  │        │   thin MCP client)│ Claude Desktop │   │ local LLMs │  │
 │  └────────┘                   └────────────────┘   └────────────┘  │
 │                                                                   │
 └───────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Layers

### 4.1 Watcher

- Linux: `inotify` via `chokidar` (pure JS, handles recursive + debounce natively). Fallback to polling where inotify is not available (WSL1, some container environments).
- Debounce: emit at most one event per file per 2 seconds. A burst of writes during a save coalesces.
- Exclude set: reuses `DEFAULT_EXCLUDE_GLOBS` from `src/config/defaults.ts`.
- Backpressure: bounded in-memory queue; if extraction can't keep up, oldest events age into a "deferred" bucket and are reprocessed on the next idle tick.

### 4.2 Extraction pool

- Current extractors (`src/extractors/textExtractor.ts` + `src/ocr/imageOcr.ts` + `src/media/imageMetadata.ts`) hoisted *outside* the DB transaction per F-009 follow-up. Extraction runs in a worker-thread pool sized to `min(4, cpuCount - 1)`.
- External binaries remain graceful optionals. `pdftotext`, `unzip`, `tesseract`, `exiftool` enrich but never block.
- Prioritization: user-edited files first, newly-created files second, historical re-extraction third (idle-only).

### 4.3 Index — five tiers, one SQLite file

Everything in one `machine-memory.sqlite` at `~/.local/share/machine-memory/`. Tiers co-exist as tables/virtual tables; no separate service.

| Tier | Purpose | Storage | Latency target |
|---|---|---|---|
| **T1 — Lexical** | Fast keyword + fuzzy match, always on | FTS5 virtual table + `file_records`/`repo_records` | < 50 ms p95 |
| **T2 — Semantic** | Embedding search for meaning-not-words queries | `sqlite-vec` `vec0` virtual table (see `docs/22-phase-2-research.md` §6) | < 200 ms p95 |
| **T3 — Knowledge graph** | Entities (people, projects, concepts, places) + relationships | `entity_records` + `relationship_records` (sketched in `docs/10-data-model.md`, schema finalized in this doc §4.4) | < 100 ms p95 for 1-2 hop traversal |
| **T4 — Wiki** | LLM-compiled markdown pages. The "pre-compiled" narrative layer Karpathy's LLM Wiki captured. | Plain markdown files under `~/.local/share/machine-memory/wiki/` + `wiki_pages` metadata table for indexing | Direct file read, negligible |
| **T5 — Activity stream** | Chronological event log (file_modified, repo_commit, shell_command, etc.) | `activity_events` (schema per `docs/22-phase-2-research.md` §2) | < 30 ms p95 for time-range queries |

### 4.4 Schema additions (vs current `src/index/schema.ts`)

```sql
-- Activity (was Phase 2 plan, now Phase 1 of v2 after the daemon skeleton)
CREATE TABLE IF NOT EXISTS activity_events (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL,
  source       TEXT NOT NULL,
  subject_id   TEXT,
  subject_type TEXT,
  subject_path TEXT,
  data_json    TEXT DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_events(at);
CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity_events(subject_type, subject_id);

-- Knowledge graph (new)
CREATE TABLE IF NOT EXISTS entity_records (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,     -- 'person' | 'project' | 'concept' | 'place' | 'topic'
  canonical_name TEXT NOT NULL,
  aliases_json   TEXT DEFAULT '[]',
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  confidence     REAL DEFAULT 1.0,
  metadata_json  TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_entity_kind ON entity_records(kind);
CREATE INDEX IF NOT EXISTS idx_entity_name ON entity_records(canonical_name);

CREATE TABLE IF NOT EXISTS relationship_records (
  id              TEXT PRIMARY KEY,
  from_id         TEXT NOT NULL,
  from_type       TEXT NOT NULL,    -- 'file' | 'repo' | 'entity'
  to_id           TEXT NOT NULL,
  to_type         TEXT NOT NULL,
  relationship    TEXT NOT NULL,    -- 'MENTIONS' | 'MODIFIED_DURING' | 'DEPENDS_ON' | 'AUTHORED_BY' | 'IN_PROJECT' | 'RELATED_TO'
  confidence      REAL DEFAULT 1.0,
  evidence_json   TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationship_records(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationship_records(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_rel_kind ON relationship_records(relationship);

-- Wiki (new — filesystem-backed, metadata only in SQLite)
CREATE TABLE IF NOT EXISTS wiki_pages (
  id              TEXT PRIMARY KEY,     -- sha1(slug)
  slug            TEXT NOT NULL UNIQUE, -- 'projects/thesis', 'concepts/eb1-evidence'
  title           TEXT NOT NULL,
  file_path       TEXT NOT NULL,        -- absolute path under wiki/
  kind            TEXT NOT NULL,        -- 'project' | 'concept' | 'person' | 'index' | 'log'
  entity_id       TEXT,                 -- optional link to entity_records
  last_compiled   TEXT NOT NULL,
  source_ids_json TEXT DEFAULT '[]',    -- which file/activity ids contributed
  metadata_json   TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_wiki_entity ON wiki_pages(entity_id);
CREATE INDEX IF NOT EXISTS idx_wiki_kind ON wiki_pages(kind);

-- Vector layer (loaded as sqlite-vec extension when present; degrades to T1 only if missing)
-- CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
--   source_id TEXT PRIMARY KEY,
--   embedding float[384]   -- tune to model
-- );
```

### 4.5 LLM compiler loop

The daemon runs a **compiler loop** that turns file change events into entity/relationship updates and wiki page revisions. Karpathy's LLM-as-compiler insight applied to a personal machine:

- Trigger: a settled file change (after debounce), or an activity burst (>5 events to the same directory in 10 min), or a manual `mm compile` call.
- Input: the changed file's text blob + its neighbors in the existing graph (2-hop) + related wiki pages.
- Output: entity inserts/updates, relationship edges, rewritten wiki pages for affected projects/concepts. Written atomically.
- Backend: **configurable**.
  - `local` — `llama.cpp` + a small quantized model (Qwen 2.5 3B or similar, ~2 GB). Pure-local, slow, fine on idle CPU.
  - `api` — Claude API. Fast, smart, costs money, sends content off-machine.
  - `off` — no compilation. Daemon still runs; wiki/entity layers stay empty. The product is still useful via T1/T2.

Default: `off` on first install. `mm compile enable --backend api|local` turns it on explicitly. This respects D-002 (local-first) by never turning on an off-machine path without the user's consent.

### 4.6 MCP surface

Five tools, specified in full in [`docs/22-phase-2-research.md`](./22-phase-2-research.md) §3 for the first two. Additions for v2:

- **`mm_find`** — primary retrieval. JSON results with provenance, resource_link citations.
- **`mm_get`** — fetch one record by id.
- **`mm_recent`** — activity-stream query. `since`, `kinds`, `path_prefix`, `limit`.
- **`mm_chat`** — multi-turn retrieval with dialogue memory. Wraps `mm_find` + short-term session state keyed by agent id. Returns both the answer *and* the chain of retrievals that backed it so the client agent can cite.
- **`mm_subscribe`** — streaming. The client registers for activity events (`kind=file_modified path_prefix=~/projects/thesis`) and receives them in real time. Enables an agent that stays aware of what the user is doing without polling.

### 4.7 CLI surface

`mm` is a thin MCP client. Every command maps to a tool call:

| CLI | MCP tool | Use |
|---|---|---|
| `mm find <q>` | `mm_find` | Keyword/NL search with pretty output |
| `mm show <id>` | `mm_get` | Full record view |
| `mm recent [--since ...]` | `mm_recent` | Activity window |
| `mm chat` | `mm_chat` | Interactive REPL |
| `mm watch <path>` | `mm_subscribe` | Stream changes |
| `mm status` | *internal* | Daemon status, index stats |
| `mm doctor` | *internal* | Same as today, plus daemon health |
| `mm compile {enable|disable|run}` | *internal* | Control the compiler loop |

---

## 5. Install Contract

`npx machine-memory init` is the product. Everything below is what happens when a user runs that one line.

1. **Pre-flight** — detect platform. Linux supported in v2; macOS + Windows in Phase 5. Exit with a clean "Linux only for now" message otherwise.
2. **Dependencies** — `better-sqlite3` and `chokidar` have pre-built binaries for common platforms. External binaries (`pdftotext`, `unzip`, `tesseract`, `exiftool`) are optional; `mm doctor` reports missing ones. The product degrades gracefully.
3. **Paths** — create `~/.config/machine-memory/config.json`, `~/.local/share/machine-memory/` (DB + wiki), and `~/.cache/machine-memory/` (tmp, artifact scratch). Respect `XDG_*` env vars.
4. **Systemd user unit** — write `~/.config/systemd/user/mmd.service`, `systemctl --user daemon-reload`, `systemctl --user enable --now mmd`. Fail soft with a printed "manual start: `mm daemon start`" if systemd is absent.
5. **MCP registration** — detect running agent tools (Claude Desktop, Claude Code, Cursor) by looking for their config files; offer to add the `mmd` MCP server entry with an explicit `y/N` prompt. Never write to those configs without consent.
6. **First scan** — kick off the initial crawl in the background. Progress streams to `~/.local/share/machine-memory/mmd.log`, tail-able with `mm status --follow`.

Uninstall: `npx machine-memory uninstall` stops the unit, removes the config/data paths on `--purge`, cleans MCP registrations.

---

## 6. Configuration

Single JSON file at `~/.config/machine-memory/config.json`, typed in `src/config/types.ts`:

```jsonc
{
  "version": 2,
  "roots": ["~/projects", "~/Downloads", "~/Desktop", "~/Pictures"],
  "excludeGlobs": [],                           // appended to DEFAULT_EXCLUDE_GLOBS
  "ocrMode": "screenshots",                     // off | screenshots | all
  "compiler": {
    "backend": "off",                           // off | local | api
    "localModel": "qwen2.5-3b-instruct-q4_0",   // llama.cpp file name
    "apiProvider": "anthropic",
    "apiModel": "claude-sonnet-4-6"
  },
  "daemon": {
    "enabled": true,
    "socketPath": "~/.local/share/machine-memory/mmd.sock",
    "debounceMs": 2000,
    "maxExtractorWorkers": 4
  },
  "mcp": {
    "registerWith": ["claude-desktop", "claude-code", "cursor"]
  }
}
```

Everything in this file is overridable per-command (`mm scan --root ...` still works), matching the existing precedence (flag > config > default).

---

## 7. Phases Rewritten As Product Layers

Each phase ships the **same daemon + CLI + MCP product**, progressively more complete. No phase ships a separate tool.

### Phase 0 — Substrate (shipped)

`mm scan`/`find`/`show`/`doctor` as a CLI tool, SQLite + FTS5, PDF/DOCX/OCR extraction, ranker, provenance. This is where we are today.

**Ship evidence:** [`docs/19-phase-1-validation.md`](./19-phase-1-validation.md).

### Phase 1 — Daemon skeleton + MCP (next)

The product becomes a daemon. This is the phase where the shape changes.

- `mmd` long-running process with `chokidar` watcher
- Watcher → existing extraction pipeline (now worker-pool, F-009 follow-up done here)
- MCP server embedded in daemon, `mm_find` + `mm_get` + `mm_recent` (recent is over `modified_at` until Phase 2 adds activity)
- `mm` CLI rewrites as MCP client talking to local socket
- `npx machine-memory init` installs systemd user unit, registers MCP with detected agent tools
- `mm status` / `mm doctor` / `mm compile` (no-op here; stub)

**Ship criterion:** `npx machine-memory init` on a clean Linux machine produces a working daemon, a registered MCP server that Claude Code can call `mm_find` on, and live-indexing of file changes within 5 seconds. Human CLI `mm find "..."` hits the daemon and returns same results it does today.

### Phase 2 — Activity + entity graph

The substrate gains a clock and relationships.

- `activity_events` table + ingesters: file-scanner hook (emit on every scan-level insert/update), git-reflog reader, screenshot mtime clustering. Shell history left opt-in (privacy, D-002).
- Delete + rename detection via sha256 + diff-of-path-sets (per [`docs/22-phase-2-research.md`](./22-phase-2-research.md) §4). Emits `file_deleted` / `file_renamed` activity events.
- `entity_records` + `relationship_records` tables. Extraction starts with the cheap/deterministic signals: repo ↔ file (IN_REPO), git author ↔ commit (AUTHORED_BY), file ↔ mentioned-path (MENTIONS). LLM-driven entity extraction deferred to Phase 3 when the compiler loop lands.
- `mm_recent` upgraded to query activity_events. `mm_find` ranker gains a recency signal from the activity stream.

**Ship criterion:** For 8/10 vague time-scoped queries ("what was I doing Tuesday?", "what did I touch on ruflo?"), the right answer is in top 3. Deletes and renames on real machine data never leave ghost entries after 24 hours of daemon uptime.

### Phase 3 — Wiki compiler

The knowledge layer. This is where Karpathy's LLM-as-compiler insight lands in our substrate.

- Compiler loop in daemon. Trigger on settled file change or activity burst.
- LLM (local or API, per config) extracts entities + relationships from changed content, then writes/updates wiki pages under `~/.local/share/machine-memory/wiki/`.
- Wiki page kinds: `projects/<slug>.md`, `concepts/<slug>.md`, `people/<slug>.md`, plus `index.md` (catalog) and `log.md` (chronological).
- Retrieval reads the wiki page *first* for known entities; falls through to T1/T2/T3 for the long tail.
- Contextual retrieval prepends the page's front-matter context to each embedded chunk (Anthropic's 35-67% retrieval-failure reduction).

**Ship criterion:** For a project with ≥ 20 files and ≥ 5 activity events, the auto-generated project wiki page answers "what is this project about?" at a level the user confirms is accurate. No manual wiki editing required.

### Phase 4 — Conversational surface

Humans stop typing commands. Agents already have this because they ARE conversational.

- `mm_chat` MCP tool with multi-turn dialogue memory scoped by agent id.
- `mm chat` CLI as a REPL over that tool.
- NL preprocessor: intent classification (search / recall / compile / act), entity + time extraction, ambiguous-follow-up handling ("which one?", "the second", "open it").
- Backend: either Claude through the compiler loop's existing `api` backend (fastest ship), or a local small model (slower but private). The user's existing Claude Code/Desktop relationship can serve as the NL surface — the daemon just provides `mm_find`-level tools.

**Ship criterion:** A user can have a 5-turn dialogue with `mm chat` about a project they actually work on and the answers stay grounded (every fact cites a file/entity/wiki page). At least one follow-up ("the second one", "when was that?") resolves correctly.

### Phase 5 — Cross-platform + polish

The product becomes shippable to a wider audience.

- macOS: `chokidar` already works; `fsevents` under the hood. Port install paths (`~/Library/...` vs XDG), the systemd unit becomes a launchd plist. External binary fallbacks (Homebrew names for `pdftotext`, etc.).
- Windows: larger port. `chokidar` handles watchers. systemd → a background service. Different path handling. Probably last.
- Performance: benchmark the daemon at 100k and 500k files. Extraction worker tuning. sqlite-vec perf.
- `mm doctor` upgraded to diagnose daemon health, MCP reachability, wiki staleness.

**Ship criterion:** `npx machine-memory init` works on macOS with the same acceptance bar as Linux. Benchmark on a 500k-file corpus completes initial scan in under 1 hour, steady-state CPU < 5% idle.

---

## 8. Open Decisions (Proposed Defaults)

Three calls that need explicit confirmation before Phase 1 starts. Each has a proposed default — override if you disagree.

**D-1: Compiler LLM default.** *Proposal:* `off` on first install. User enables explicitly with `mm compile enable --backend {local|api}`. Rationale: respects D-002 (local-first, privacy-first) by never turning on an off-machine or heavy-local workload without consent. Daemon is useful without a compiler.

**D-2: Daemon host.** *Proposal:* `systemd --user` unit on Linux. Fallback to shell-rc `&` if systemd absent. macOS uses launchd at Phase 5. Rationale: systemd user units handle restart, logging, resource caps for free.

**D-3: MCP registration behavior.** *Proposal:* `init` detects installed agent tools (Claude Desktop, Claude Code, Cursor) by their config locations and **prompts for each** before writing anything. No silent edits to user config files. Rationale: writing to a user's agent config is a trust boundary; cross it explicitly.

---

## 9. Ingredients — What We Are Stealing From Where

| From | What we take | Why |
|---|---|---|
| [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | LLM-as-compiler, raw/ vs wiki/ split, Obsidian-compatible markdown, `index.md` + `log.md` skeleton | The wiki layer that makes retrieval cheap and explainable |
| [Microsoft GraphRAG](https://microsoft.github.io/graphrag/query/local_search/) | Entity extraction, relationship edges, community reports, 5-source context assembly at query time | T3 knowledge graph + how to compose retrieval results before returning |
| [Mem0 state of AI agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) | Selective vector memory, reranking, async writes, actor-aware scoping, LOCOMO-style evaluation | T2 vector layer shape, benchmark discipline |
| [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) | Prepend 50-100 token context to each chunk before embedding | Makes T2 vector retrieval 35-67% more accurate at marginal cost |
| [ActivityWatch aw-core](https://github.com/ActivityWatch/aw-core) | Event/bucket model with a flexible JSON `data` field | T5 activity stream shape |
| [MCP 2025-06-18 spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | Tool definitions with `inputSchema` + `outputSchema`, `structuredContent`, `resource_link`, streaming | How agents actually call us |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | `vec0` virtual table alongside FTS5 in the same SQLite file | T2 semantic layer without a separate service |

The ingredients are all well-understood in isolation. **The novelty is the combination, local-first, one-line-installable, agent-first.** The competitive landscape doc ([14-competitive-landscape.md](./14-competitive-landscape.md)) confirms nobody ships this today.

---

## 10. Success Criteria

### Overall product

Machine Memory v2 succeeds when:

1. A one-line install on a fresh Linux machine produces a running daemon + CLI + MCP server within 2 minutes.
2. The daemon stays up across reboots with no manual intervention.
3. An AI agent on the machine can call `mm_find` and get better context than it would by running `grep -r` or `find`, for a task the user cares about.
4. A human can ask `mm find "..."` and find what they meant, with provenance, on their real machine.
5. The user trusts the output enough to act on it without re-verification.

### Per-phase (summary — detail in §7)

- Phase 1: agent can call `mm_find`; live-index within 5s.
- Phase 2: 8/10 vague time queries in top 3; no ghost deletes/renames.
- Phase 3: auto-generated project wiki page is confirmed accurate.
- Phase 4: 5-turn grounded dialogue with follow-up resolution.
- Phase 5: macOS install works; 500k-file scan under 1 hour.

---

## 11. Risks And Mitigations

**R-1: Scope creep on the daemon.** The daemon can absorb everything. Mitigation: per-phase ship criterion above. If a nice-to-have doesn't map to a phase criterion, it's a followup.

**R-2: Local LLM compiler is slow or bad at extraction.** Mitigation: compiler backend is `off` by default. We ship a useful product without it. Users who want the wiki layer opt in. If local quality is poor, we lean on API backend with informed consent.

**R-3: MCP registration friction.** If Claude Desktop / Cursor / Claude Code config formats diverge and break, `init` fails mid-way. Mitigation: every MCP write is prompted, reversible, and the daemon is fully usable via direct `mm` CLI even with no agents registered.

**R-4: Daemon reliability.** A background process that crashes silently is worse than a CLI that errors out. Mitigation: systemd `Restart=on-failure`, structured logs to `~/.local/share/machine-memory/mmd.log`, `mm status` shows crash/restart counts. Health-check endpoint over the MCP socket.

**R-5: Cross-platform pain kills momentum.** macOS and Windows add real work. Mitigation: Linux-only through Phase 4. Platform expansion is its own phase with its own ship bar.

**R-6: EB1 commit narrative coherence.** Collapsing six phases into "build the product shape first" is a real pivot. Mitigation: this doc exists. The commit landing this file becomes the pivot marker. D-019 in the decision log records the rationale. No silent roadmap drift.

---

## 12. How This Doc Relates To The Rest Of `docs/`

| File | Relationship to this doc |
|---|---|
| [`01-product-thesis.md`](./01-product-thesis.md) | North star; this doc is the architecture realization of it |
| [`06-roadmap-phases.md`](./06-roadmap-phases.md) | Rewritten to match §7 |
| [`13-decision-log.md`](./13-decision-log.md) | D-019 records the phase collapse captured here |
| [`15-current-state.md`](./15-current-state.md) | Updated to point at this doc as the canonical architecture |
| [`20-phase-1-followups.md`](./20-phase-1-followups.md) | F-010 and F-011 closed as superseded; F-009 follow-up kept |
| [`22-phase-2-research.md`](./22-phase-2-research.md) | Preserved as technical research; the v2 Phase 2 still uses its activity event schema + MCP schemas + sqlite-vec analysis |
| [`10-data-model.md`](./10-data-model.md) | Will be updated in-slice when schema additions in §4.4 land in code |
| Others | Unchanged; they describe truths (competitive landscape, problems-and-users, etc.) that still hold |

---

## Sources

Primary:

- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Karpathy's LLM Knowledge Bases tweet](https://x.com/karpathy/status/2039805659525644595)
- [Microsoft GraphRAG local-search documentation](https://microsoft.github.io/graphrag/query/local_search/)
- [Mem0 state of AI agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [MCP 2025-06-18 tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [ActivityWatch aw-core models.py](https://github.com/ActivityWatch/aw-core/blob/master/aw_core/models.py)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [SQLite pragma.html](https://www.sqlite.org/pragma.html)

Internal:

- [`docs/22-phase-2-research.md`](./22-phase-2-research.md) — SQLite pragma tuning (§1), activity event schema (§2), MCP tool schemas (§3), rename detection (§4), sqlite-vec semantic plan (§6). Still primary technical reference for these layers.
- [`docs/14-competitive-landscape.md`](./14-competitive-landscape.md) — confirms the product-shape gap in the market.
- [`docs/20-phase-1-followups.md`](./20-phase-1-followups.md) — open technical work the daemon must carry.
