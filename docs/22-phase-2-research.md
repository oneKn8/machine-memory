# Phase 2 Research And F-009 Resolution Plan

Status: research notes, dated 2026-04-18. Each section ends with a concrete proposal for the repo to act on.

This document is opinionated. Where prior art settles a question, the source is cited. Where the question is actually novel for our north star (D-018: AI agents are a first-class user), the design is called out as a deliberate invention, not copied.

## 1. F-009 Resolution — SQLite Bulk-Write Throughput

### Current state

`src/index/db.ts` opens the database with only:

```ts
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
```

That leaves every other performance-relevant pragma at SQLite defaults. The defaults are safe but pessimal for our workload, which is "many small writes from a single-process scanner."

Specifically: `synchronous` defaults to `FULL`, which forces an `fsync()` after every commit. With the per-batch commit model we landed in the F-007 fix, that fsync runs once per 500 files — roughly 150 times for a full `~/projects` scan. That is the direct cause of the 30–50 files/sec → ~7.5 files/sec regression captured as F-009.

### Authoritative guidance

SQLite's own docs ([sqlite.org/pragma.html](https://www.sqlite.org/pragma.html)) are explicit: in WAL mode, `synchronous = NORMAL` is *consistent* (no corruption risk) but *loses last-transaction durability* on power loss. Quoted from the pragma page:

> WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability. A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash.

For a local search index that can always be rebuilt from the filesystem, losing the last batch of commits on a crash is acceptable. The index will reconverge on the next scan via the fingerprint cache.

better-sqlite3's own performance notes ([WiseLibs/better-sqlite3 perf doc](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)) confirm the library already defaults WAL to `NORMAL` via `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` at compile time. What we observed in the slow scan suggests either the compile-time default is not in effect in our build (worth verifying) or — more likely — the per-batch transaction boundary itself is still expensive because a pdftotext/unzip subprocess spawn plus its write hits `synchronous=FULL`-sized fsync pressure inside the transaction.

### Proposal

Set the pragmas below at database open time. Numbers are calibrated to our workload (single-writer, ~75k files max across all roots, ~100 MB DB so far):

```ts
db.pragma('journal_mode = WAL')             // already set
db.pragma('busy_timeout = 5000')            // already set
db.pragma('synchronous = NORMAL')           // NEW — primary speedup
db.pragma('cache_size = -64000')            // NEW — 64 MB page cache
db.pragma('temp_store = MEMORY')            // NEW — temp indices in RAM
db.pragma('mmap_size = 268435456')          // NEW — 256 MB mmap window
db.pragma('wal_autocheckpoint = 5000')      // NEW — fewer checkpoint stalls
db.pragma('journal_size_limit = 67108864')  // NEW — 64 MB WAL cap
```

Expected impact per source ([sqlite.org/pragma.html §synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)): 5–10× sustained write throughput on NORMAL vs FULL. Combined with the larger cache (which keeps hot pages in memory instead of re-reading on every batch), the projected end-to-end throughput is back above the original single-transaction scan rate (~50 files/sec), while keeping the WAL bounded.

### Second-order optimization — hoist extraction out of the transaction

Currently the batch transaction wraps both the DB writes AND the `spawnSync(pdftotext | unzip | tesseract)` calls. That means the SQLite lock is held while an external subprocess runs I/O on a separate file. Hoisting extraction outside the transaction and only wrapping the blob writes lets the transaction be sub-millisecond:

```
for batch of 500:
  extract all blobs (no DB lock)          ← expensive, but parallel-friendly
  db.transaction(() => write all blobs)   ← fast, fsync amortized
```

This also opens the door to parallel extraction (worker threads running pdftotext on N files concurrently), which the current design forecloses.

### Action items

1. Update `src/index/db.ts` to set the pragmas above. Ship as its own commit.
2. Re-benchmark `~/projects` scan cold (DB checkpointed first) to produce before/after numbers. Commit the numbers in `docs/20-phase-1-followups.md` under F-009 resolution.
3. Defer the extraction-hoist refactor to a follow-up commit once the pragma change lands clean, to keep the diff small and the performance attribution clear.

---

## 2. Phase 2 Activity Model — Schema Proposal

### The real question

The roadmap says Phase 2 answers "what was I doing?" but does not specify the schema. Two extremes exist:

- **Narrow V1:** derive activity purely from existing `file_records.modified_at` and `repo_records.last_commit_at`. No new tables. `mm recent` just runs `SELECT ... ORDER BY modified_at DESC WHERE modified_at > ?`.
- **Full V2:** a real activity event stream with a new table, multiple ingesters (shell history, git reflog, file atime, screenshot timestamps), and session clustering.

Narrow V1 ships in a day and covers maybe 40% of the user's actual recall questions. Full V2 is ~2 weeks but is the real substrate. The doc `10-data-model.md:138` already lists `EventRecord` as a "Future Record Type" — Phase 2 is the time to promote it.

### Prior art

**ActivityWatch** ([aw-core models.py](https://github.com/ActivityWatch/aw-core/blob/master/aw_core/models.py)) uses a deliberately minimal event shape:

```python
class Event:
    id: Optional[int | str]
    timestamp: datetime
    duration: timedelta
    data: Dict[str, Any]
```

Events are grouped by **bucket** (a named stream — e.g. `aw-watcher-window`, `aw-watcher-afk`, `aw-watcher-web`). Each bucket is produced by one watcher. Queries merge events across buckets into a timeline via their query DSL.

The lesson: a flexible `data` JSON blob plus a bucket/source identifier is enough to model heterogeneous event sources without a table-per-kind explosion.

**Git reflog + shell history** are the two cheapest wins that are NOT in ActivityWatch: they give text-level context ("I ran `npm test`", "I checked out branch X") that a file-mtime stream alone misses.

### Proposed schema (V2, but shippable in slices)

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id           TEXT PRIMARY KEY,           -- sha1(source + timestamp + subject)
  at           TEXT NOT NULL,              -- ISO 8601 UTC
  duration_ms  INTEGER NOT NULL DEFAULT 0, -- 0 for instants
  kind         TEXT NOT NULL,              -- 'file_modified' | 'repo_commit' | 'shell_command' | 'screenshot' | 'git_checkout'
  source       TEXT NOT NULL,              -- ingester name ('file-scanner', 'git-reflog', 'shell-history')
  subject_id   TEXT,                       -- optional: file_records.id / repo_records.id if linkable
  subject_type TEXT,                       -- 'file' | 'repo' | null
  subject_path TEXT,                       -- denormalized for fast query without join
  data_json    TEXT DEFAULT '{}',          -- ingester-specific payload
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_events(at);
CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_events(source, at);
```

**Design decisions that differ from ActivityWatch, on purpose:**

- We denormalize `subject_path` into the event. ActivityWatch's `data.app = "code"` is fine for desktop-activity tracking, but our north star is file-and-repo recall — so joining `activity_events` back to `file_records` on every query would burn too much time. Keeping the path on the event means `"what did I touch in ~/projects/ruflo last Tuesday?"` is a single indexed range scan.
- We explicitly type `kind` rather than leaving it in `data_json`. Typed kinds are what ranker/filter code will switch on; leaving them in JSON forces parsing on every row.
- `duration_ms` is nullable-equivalent (default 0). Most of our initial events are instants (`file_modified`, `repo_commit`, `shell_command`). Sessions come later as a derived view, not a new table.

### Ingesters and their slicing order

1. **file-scanner (already exists, minor extension).** When the scanner inserts/updates a `file_records` row, also emit a `file_modified` activity event. Zero new I/O.
2. **git-reflog.** `git reflog --date=iso` per indexed repo → `repo_commit` and `git_checkout` events. Cheap, runs at the same time as `scanRepos`.
3. **shell-history.** Parse `~/.bash_history` / `~/.zsh_history` for commands + timestamps. Historically noisy (privacy) — make it opt-in via config, per D-002 privacy-first.
4. **screenshot-timestamps.** Already have `file_records` for screenshots; the event just lifts the mtime/EXIF time into a `screenshot` event kind.
5. **file-access (Phase 6 territory).** File atime is notoriously unreliable on modern distros (`relatime`, `noatime`). Wait for Phase 6 fanotify/inotify before taking this on.

### Query surface (V1 and V2)

**V1 commands, over the new table:**

```
mm recent [--since 1d] [--kind file_modified,repo_commit] [--path ~/projects/ruflo]
mm what-was-i-doing <date>          # groups events by source_path, orders by count+recency
mm timeline <range>                 # raw event stream, for debug
```

**V2 commands, once sessions and clustering land:**

```
mm session <id>                     # show one work session (detected via gap threshold)
mm resume                           # "pick up where you left off" — last active repo + recent files
mm project-history <repo>           # all activity on a repo over time
```

### Ship criterion for Phase 2

The roadmap said "user can recover recent workstreams by timeframe or project." That is too vague to grade. Concrete proposal: **for 8 out of 10 vague time-scoped queries of the form "what was I doing [timeframe]?" or "what did I touch on [project]?", the correct top answer appears in the first three results.**

That is the Phase 1 trust bar (D-005) translated into Phase 2 activity terms.

---

## 3. F-012 Agent Interface — Concrete MCP Shape

### What the MCP spec actually says

From [modelcontextprotocol.io/specification/2025-06-18/server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):

- Tools are identified by a `name`, an `inputSchema` (JSON Schema), and optionally an `outputSchema`.
- Tool results can have **unstructured `content`** (text/image/audio/resource_link) AND **`structuredContent`** (a JSON object matching `outputSchema`). When an output schema exists, clients MUST validate.
- The **resource_link** content type is important: a tool can return `{ "type": "resource_link", "uri": "file:///path", "name": "...", "mimeType": "..." }` — exactly what a local search tool wants, because a text chunk can cite the file it came from without inlining the whole file.
- **Embedded resources** allow inlining actual file content when the agent wants it (`type: "resource"` with a `resource: { uri, mimeType, text }`).

The takeaway: MCP already gives us the exact vocabulary we need to return grounded, citable results to an AI agent — we do not need to invent a protocol, we need to map our retrieval output onto this vocabulary.

### Anthropic's retrieval insight worth stealing

From [Anthropic's Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval):

- Prepending a 50–100 token contextual description to each chunk before embedding reduced retrieval failure 35% alone, 49% combined with contextual BM25, 67% with reranking added.
- The approach explicitly combines semantic search + BM25, i.e. FTS-style lexical search — which is exactly what we already have.
- Cost at scale is ~$1.02 per million document tokens with prompt caching.

For our repo this maps cleanly to: when we extract a PDF/DOCX/markdown chunk, store an optional `context` column on `text_blobs` that contains a short "this chunk is from {file} which is about {repo/topic}" preamble. It's cheap to compute once, compound benefits forever.

### Proposed MCP tool surface for Phase 5

Two tools, minimum:

#### `mm_find`

```json
{
  "name": "mm_find",
  "description": "Search the local machine's indexed memory. Returns a ranked set of files, repos, and text snippets with provenance. Use before blindly reading directories.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":       { "type": "string", "description": "Natural language or keyword query" },
      "kinds":       { "type": "array", "items": { "enum": ["file","repo","screenshot","pdf","docx","code"] } },
      "path_prefix": { "type": "string", "description": "Restrict to paths under this prefix" },
      "since":       { "type": "string", "description": "ISO 8601 timestamp; only return items modified since" },
      "limit":       { "type": "integer", "default": 5, "maximum": 20 }
    },
    "required": ["query"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "results": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id":         { "type": "string" },
            "kind":       { "type": "string", "enum": ["file","repo"] },
            "path":       { "type": "string" },
            "title":      { "type": "string" },
            "score":      { "type": "number" },
            "last_modified": { "type": "string" },
            "provenance": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "extractor": { "type": "string" },
                  "snippet":   { "type": "string" },
                  "span":      { "type": "array", "items": { "type": "integer" } }
                }
              }
            }
          },
          "required": ["id","kind","path","score","provenance"]
        }
      }
    },
    "required": ["query","results"]
  }
}
```

The tool MUST also return the result list as `content: [{ type: "text", text: JSON.stringify(structured) }]` for backward compatibility with clients that don't validate structured content. For each result, optionally return a `resource_link` in `content[]` pointing at the file so the agent can fetch it without re-running `mm_find`.

#### `mm_get`

Given an id from `mm_find`, return the full record:

```json
{
  "name": "mm_get",
  "description": "Fetch one indexed record by id. Returns full metadata and available text blobs. Use after mm_find to read a candidate.",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "string" } },
    "required": ["id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "id":       { "type": "string" },
      "kind":     { "type": "string" },
      "path":     { "type": "string" },
      "metadata": { "type": "object" },
      "blobs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "extractor_type": { "type": "string" },
            "content":        { "type": "string" },
            "truncated":      { "type": "boolean" }
          }
        }
      }
    }
  }
}
```

### Why this is the right shape for our north star

A coding agent that would otherwise `grep -r stats ~/projects` gets instead: a 5-result JSON array with score, path, and the exact snippet that matched. It can reason on the snippet and call `mm_get` on the top hit if it needs the full file. That is the entire "context substrate" promise (D-018) translated into 2 tools and ~60 lines of JSON schema.

### Internal retrieval API to stabilize now

Looking at `src/search/find.ts`, `findMatches()` already returns a `SearchResult[]` internally. Phase 2 and Phase 3 should treat that shape as the canonical retrieval contract: anything added to it (source hints, provenance arrays, structured snippets) should also be the shape the Phase 5 MCP adapter serializes. Recommended near-term refactor: promote `SearchResult` into a typed `RetrievalResult` with required `provenance: ProvenanceEntry[]`, so the pretty-print CLI and the future MCP server are both thin adapters over it.

---

## 4. F-011 Rename Detection — Git-Inspired Local Algorithm

### Prior art

Git's rename detection ([gitdiffcore](https://git-scm.com/docs/gitdiffcore) + [Chelsea Troy's explainer](https://chelseatroy.com/2020/05/09/question-how-does-git-detect-renames/)):

1. Collect the set of deleted files (in Git: staged deletions) and added files.
2. Prefilter candidates by size (skip pairs whose sizes differ by more than a threshold).
3. Compute a Rabin-Karp rolling-hash chunk signature for each candidate file.
4. Similarity score = fraction of shared chunks between a delete/add pair.
5. Threshold default 50% (`-M50`); pairs above threshold are renames.

### Proposal for the scanner

We do not need Git-level fidelity. We need to catch the common case: a user renames a file and we correctly update the record instead of creating a ghost.

**Step 1 (cheap, ship first):** add `sha256` column to `file_records` — already sketched in `docs/10-data-model.md:26`. Compute on content during extraction. For binary files >50 MB, hash only the first 1 MB + last 1 MB + size (still catches true renames, avoids hashing huge media files).

**Step 2 (rename detection at scan time):**

```
let seen_paths = set of paths returned by fast-glob
let existing_paths = set of paths in file_records with source_root = current root
let missing_paths = existing_paths - seen_paths     // candidates for deletion
let new_paths = seen_paths - existing_paths        // candidates for creation

for each new_path:
    compute sha256 of new_path
    match_candidates = records in missing_paths with matching sha256
    if match_candidates.len == 1:
        → treat as rename: update file_records row's path to new_path,
          emit activity_event kind='file_renamed'
    elif match_candidates.len > 1:
        → ambiguous: do nothing (safer than wrong rename), log warning
    else:
        → genuine new file: insert normally

for each still-missing_path after rename matches:
    → delete: emit activity_event kind='file_deleted',
      either delete the record or mark it with a tombstone flag
```

**Deletion policy call:** soft-delete (tombstone flag) vs hard-delete. Soft-delete preserves activity history ("this file used to exist and was deleted on X"), matching Phase 2's north star. Recommend tombstone flag via `metadata_json.deletedAt`.

### When to ship

Bundle with the Phase 2 activity table, not before. Rename/delete signal is only valuable once there is an activity stream to emit it into.

---

## 5. Phase 6 Real-Time Indexing — inotify vs fanotify

Documenting the Phase 6 tradeoff now so we don't have to re-research it later. Nothing to implement yet.

### Hard limits and costs

- inotify watches are per-directory (NOT recursive). Each watch costs ~1080 bytes of kernel memory on 64-bit ([watchexec inotify limits](https://watchexec.github.io/docs/inotify-limits.html)).
- `fs.inotify.max_user_watches` default: 8192. On kernels ≥5.11 it auto-scales up to ~1M based on RAM. On older or constrained systems, hitting the limit silently falls back to broken indexing.
- fanotify ([man fanotify.7](https://man7.org/linux/man-pages/man7/fanotify.7.html)) can watch an entire mount atomically, race-free — but requires `CAP_SYS_ADMIN` for that mode.

### Recommendation

Start with **inotify + aggressive exclude set** (same excludes the scanner uses). On a dev laptop with ~100k watched paths after excludes, we stay well under the default 8192-scaled-by-kernel and avoid the root privilege requirement. Document the `/etc/sysctl.d/90-machine-memory.conf` override (`fs.inotify.max_user_watches = 524288`) as an optional step for power users with larger trees.

Fanotify is parked until a user actually asks for root-owned mounts or wants race-free fresh-boot indexing.

### Event handling shape

Whatever watcher we use, it MUST enqueue into the same `activity_events` pipeline rather than writing to `file_records` directly. That keeps the Phase 6 code purely additive: the scanner remains the source of truth for the file table, the watcher just emits activity that triggers targeted re-extraction for specific paths.

---

## 6. Semantic Retrieval — Unlocking D-011 When The Time Comes

D-011 said semantic retrieval is delayed until baseline search works. Baseline search now works (Phase 1 reopen). The remaining question is: when we cross the semantic threshold, what engine?

### sqlite-vec

[sqlite-vec](https://github.com/asg017/sqlite-vec) ships as a SQLite extension, has Node.js bindings, supports float/int8/binary vectors in `vec0` virtual tables, and runs wherever SQLite runs. Pre-v1 but funded by Mozilla Builders, Fly.io, Turso, SQLite Cloud. 7.4k stars as of 2026-04.

The fit for us is almost too clean: we already use SQLite + FTS5; `vec0` would sit alongside as a sibling virtual table. Our existing `text_blobs` becomes the chunk store, an `embedding_refs` table (already foreshadowed in `10-data-model.md:79`) links blobs to vectors.

### The hybrid retrieval strategy to plan for

Per Anthropic's numbers, the combination that matters is:

1. **BM25 / FTS5** (what we have) — captures exact keyword match.
2. **Contextual embeddings** — captures semantic intent.
3. **Rerank top 20 → top 5** — sharpens.

Rather than adding embedding at Phase 2, defer it to a Phase 2.5 or explicit Phase 2 extension once we see *which* queries FTS fails on. That concrete miss corpus is worth more than guessing which embedding model is "best."

### Contextual prefix proposal

When a chunk is extracted from a file in a repo, store on the `text_blobs` row (or a sidecar) a one-line `context_prefix`:

```
This chunk is from README.md in repo `machine-memory`, a local-first search engine.
```

Generated once per file, not per scan. Cheap to compute deterministically from `repo_records.repo_name + first H1 of README + file basename` without any LLM call. If/when we add a local model, the same field can be upgraded with model-generated prose without schema changes.

---

## Summary — What This Doc Commits Us To

- **Immediately (F-009 fix):** add the five new pragmas in `src/index/db.ts`. Measure. Commit with before/after numbers. Unblocks F-010 (scheduled scans).
- **Phase 2 design locked:** activity events are a first-class new table (`activity_events`), typed kind, denormalized subject_path, JSON data. Ingesters ship in order file-scanner → git-reflog → shell-history → screenshot-timestamps. Ship criterion: 8/10 vague time-scoped queries land the right answer in top 3.
- **Phase 2 internal API contract:** `RetrievalResult` with required `provenance` array becomes the shared shape between CLI and future MCP server.
- **Phase 5 pre-baked:** MCP tool surface is `mm_find` + `mm_get` with the exact JSON schemas above. No invention required at Phase 5 time — the schema has already been designed.
- **F-011 bundled with Phase 2:** rename detection via sha256 + diff sets, soft-delete with tombstones.
- **Phase 6 parked but scoped:** inotify + excludes is the path, fanotify is only if a specific need justifies CAP_SYS_ADMIN.
- **Semantic retrieval deferred to Phase 2.5 or later:** sqlite-vec is the plan, with a BM25+vec+rerank hybrid per Anthropic's numbers. Start collecting the FTS-miss corpus now so embedding work is driven by real gaps, not guessing.

## Sources

- [sqlite.org/pragma.html](https://www.sqlite.org/pragma.html) — authoritative pragma reference
- [WiseLibs/better-sqlite3 performance.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — library-specific notes
- [ActivityWatch aw-core models.py](https://github.com/ActivityWatch/aw-core/blob/master/aw_core/models.py) — event/bucket shape
- [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) — retrieval accuracy research
- [MCP 2025-06-18 tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — tool and output schema protocol
- [gitdiffcore](https://git-scm.com/docs/gitdiffcore) and [Chelsea Troy's explainer](https://chelseatroy.com/2020/05/09/question-how-does-git-detect-renames/) — Git rename detection algorithm
- [watchexec inotify-limits](https://watchexec.github.io/docs/inotify-limits.html) and [man fanotify.7](https://man7.org/linux/man-pages/man7/fanotify.7.html) — Linux filesystem watcher limits
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) — local vector search extension
