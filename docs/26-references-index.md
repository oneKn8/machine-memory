# References Index — Knowing What Points At What

**Dated:** 2026-04-25.

**Status:** Proposed. Slots into the existing daemon (`mmd`) as a new scanner alongside `src/scanner/fileScanner.ts`. Does not change Phase 1 ship goals — adds a Phase 1.5 capability that protects the user (and any agent operating on their behalf) from breaking the machine when reorganizing files.

**Inputs this doc synthesizes:**

- [`docs/05-system-architecture.md`](./05-system-architecture.md) — current scanner / index split.
- [`docs/12-ingest-sources.md`](./12-ingest-sources.md) — tiered ingest principle. References sit cleanly in Tier 1.5 (high signal, moderate parser cost).
- [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) — daemon as substrate; this is one more index tier the daemon maintains.
- [`docs/22-phase-2-research.md`](./22-phase-2-research.md) — MCP tool surface conventions.

---

## 1. Motivation — The Bug This Closes

On 2026-04-25 a directory reorganization moved `~/Pictures/wallpapers/*` to `~/media/Pictures/wallpapers/*` and `~/projects/ai-agents/voicetype/` to `~/projects/ai/ai-agents/voicetype/`. Two unrelated systems silently broke:

1. **GNOME desktop background.** `gsettings org.gnome.desktop.background picture-uri` still pointed at the old path. The user saw a blue fallback after reboot.
2. **Undertone voice typing.** The systemd user unit `~/.config/systemd/user/undertone.service` had three hardcoded paths (`WorkingDirectory`, `Environment=PYTHONPATH=...`, `ExecStart=`) all under the old project root. The service entered a crash-restart loop, attempted 60 restarts before discovery, and exit code 203/EXEC was the only signal anything was wrong.

Both failures are the same shape: **a configuration file in a known location holds a path string that points at a file in another known location, and nothing checks the link**. Today we discover these breaks by waiting for visible failure (a blue desktop, a broken hotkey). Phase 0 retrieval (`mm find`) does not catch them because finding a file does not tell you who depends on it.

The asymmetry that matters: an agent doing a reorg is fast at moving files but slow at remembering that a `gsettings` key three layers deep references one of those files. A references index inverts the lookup so the answer to *"what will I break if I move this?"* is one MCP call.

---

## 2. What This Adds

A new index tier — **T-Refs** — populated by a new scanner family — **referenceScanners** — that parses configuration sources for outbound path references. Stored in the existing SQLite database alongside the FTS5 lexical index. Exposed via two new MCP tools.

Concretely:

- **Scanner family**, one parser per source type, each emitting normalized `Reference` rows.
- **Schema**, two SQLite tables (`refs` and `ref_sources`) with indexes that make both forward and reverse lookups O(log n).
- **MCP tools**, `mm_refs_to(path)` and `mm_refs_broken()`.
- **Watcher hook**, when a file is moved or deleted, the daemon enqueues a refs-validation pass for any reference whose `target_path` matched the old location.

What this is **not**: a writer. The references index never modifies the source config. It reports. The agent (or human) decides whether to patch a `gsettings` value or edit a unit file. Writing back is a separate decision recorded in the decision log if and when we make it, because it crosses the line from "knowing the machine" to "operating the machine" and the safety story is different.

---

## 3. Sources To Index — Tier R1

Five sources cover the overwhelming majority of real desktop breakage on a Linux user's machine. Build these first, accept that exotic configs slip through.

| Source | Where | What we extract | Parser cost |
|---|---|---|---|
| systemd user units | `~/.config/systemd/user/*.service`, `*.timer`, `*.socket` | `ExecStart=`, `ExecStartPre=`, `ExecStartPost=`, `WorkingDirectory=`, `EnvironmentFile=`, `Environment=…=<path>` | low (INI-ish) |
| gsettings keys with file URIs | `gsettings list-recursively` filtered to values starting `file://` | the URI's path | low |
| XDG autostart and `.desktop` launchers | `~/.config/autostart/*.desktop`, `~/.local/share/applications/*.desktop`, `/usr/share/applications/*.desktop` (read-only for the system set) | `Exec=`, `Icon=`, `TryExec=` | low (INI) |
| user crontabs and cron drop-ins | `crontab -l` for the running user, `~/.config/cron*` if present | tokens that look like absolute paths after the schedule fields | low |
| shell rc files | `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.config/fish/config.fish`, files they `source` | `alias x='/abs/path …'`, `export PATH=…:/abs/path:…`, `source /abs/path`, `[[ -f /abs/path ]] && …` | medium (shell quoting) |

Tier R2 — add after R1 ships and the schema is stable:

- MCP server registrations (`~/.claude/settings.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, etc.) — paths to local servers, env files, working dirs.
- Editor configs that reference scripts (`~/.vscode/`, `~/.config/Code/User/settings.json`, JetBrains run configs).
- Docker compose files and `Dockerfile` `COPY src dst` host-side `src` paths.
- Git hooks under `~/.config/git/hooks` and per-repo `core.hooksPath` overrides.

Tier R3 — defer until there is real demand:

- `/etc/systemd/system/` (system-level units, requires root to fix anyway).
- nginx / apache / caddy configs (only relevant if the user runs servers).
- Application-specific config (Obsidian vault paths, Logseq graphs, etc.).

---

## 4. Schema

Two tables, both in the existing `mmd.db` SQLite file.

```sql
CREATE TABLE ref_sources (
  id            INTEGER PRIMARY KEY,
  source_kind   TEXT NOT NULL,           -- 'systemd_unit' | 'gsettings' | 'desktop_entry' | 'crontab' | 'shell_rc'
  source_path   TEXT NOT NULL,           -- absolute path to the config file, OR a synthetic key like 'gsettings:org.gnome.desktop.background.picture-uri'
  scanned_at    INTEGER NOT NULL,        -- unix ms; refresh on mtime change or watcher event
  source_mtime  INTEGER,                 -- file mtime if applicable
  UNIQUE(source_kind, source_path)
);

CREATE TABLE refs (
  id              INTEGER PRIMARY KEY,
  source_id       INTEGER NOT NULL REFERENCES ref_sources(id) ON DELETE CASCADE,
  field           TEXT NOT NULL,         -- 'ExecStart' | 'WorkingDirectory' | 'value' | 'Exec' | 'alias:undertone' | 'PATH' | etc.
  raw_value       TEXT NOT NULL,         -- the unexpanded string as it appears in the source
  target_path     TEXT NOT NULL,         -- expanded, absolute, normalized; populated when we can resolve it
  target_exists   INTEGER NOT NULL,      -- 0/1 cached at last validation
  last_checked_at INTEGER NOT NULL,
  line            INTEGER,               -- line number in the source file when applicable
  notes           TEXT                   -- e.g. 'ExecStart first token only', 'PATH entry 3 of 7'
);

CREATE INDEX refs_target_path_idx  ON refs(target_path);
CREATE INDEX refs_source_id_idx    ON refs(source_id);
CREATE INDEX refs_broken_idx       ON refs(target_exists) WHERE target_exists = 0;
```

Normalization rules for `target_path` so reverse lookup actually works:

- Resolve `~`, `$HOME`, and `${HOME}` against the daemon's owning user.
- Resolve `file://` URI-encoded paths.
- For `PATH`-like colon-separated lists, emit one row per entry.
- For `ExecStart=cmd arg arg`, store the first token (the executable) as the primary `target_path`; if subsequent tokens are absolute paths that exist on disk, emit additional rows with `field='ExecStart:arg<n>'`.
- Do not follow symlinks during normalization. Store the literal path the config writes; resolve symlinks only at validation time. Otherwise a symlink swap silently changes what every reference "means."

---

## 5. Validation Loop

Two triggers:

1. **On scan.** When a `ref_sources` row is inserted or refreshed, every emitted `refs.target_path` is `stat`-checked. `target_exists` is set, `last_checked_at` is updated.
2. **On filesystem event from the watcher.** When the daemon's existing inotify pipeline reports a `MOVED_FROM` or `DELETE` for path `P`, run `SELECT id FROM refs WHERE target_path = P` and re-validate each. On a `MOVED_TO` to `Q` paired with the same cookie, mark the affected refs as broken and store `Q` as a candidate fix in a separate `ref_fix_candidates` column (added later — out of scope for this slice).

The validation loop is cheap. A `stat` per ref, batched, is microseconds. The watcher already has the events; this is one extra SQL query per relevant event.

---

## 6. MCP Tool Surface

Two tools added to `mmd`'s embedded MCP server. Names follow the existing `mm_*` convention from [`docs/22-phase-2-research.md`](./22-phase-2-research.md).

### `mm_refs_to`

Input:

```json
{ "path": "/home/oneknight/Pictures/wallpapers/glacier.jpg" }
```

Returns every reference whose `target_path` equals the input *or whose `target_path` is a prefix of the input* (so asking about a directory surfaces refs to files inside it).

```json
{
  "path": "/home/oneknight/Pictures/wallpapers/glacier.jpg",
  "references": [
    {
      "source_kind": "gsettings",
      "source_path": "gsettings:org.gnome.desktop.background.picture-uri",
      "field": "value",
      "raw_value": "file:///home/oneknight/Pictures/wallpapers/glacier.jpg",
      "target_exists": false
    }
  ],
  "count": 1
}
```

Use case: **before** an agent moves or deletes anything, it calls `mm_refs_to` on every affected path and shows the user (or refuses to proceed silently) if anything points at it.

### `mm_refs_broken`

Input: optional filter.

```json
{ "source_kind": "systemd_unit" }
```

Returns every ref currently flagged `target_exists = 0`, grouped by source.

```json
{
  "broken": [
    {
      "source_kind": "systemd_unit",
      "source_path": "/home/oneknight/.config/systemd/user/undertone.service",
      "fields": [
        { "field": "WorkingDirectory", "raw_value": "/home/oneknight/projects/ai-agents/voicetype" },
        { "field": "Environment:PYTHONPATH", "raw_value": "/home/oneknight/projects/ai-agents/voicetype/src" },
        { "field": "ExecStart", "raw_value": "/home/oneknight/projects/ai-agents/voicetype/.venv/bin/python" }
      ]
    }
  ],
  "count": 1
}
```

Use case: a one-shot "what's silently broken on my machine right now" query. Run after any reorg. Run on daemon startup. Surfaceable via `mm refs broken` from the CLI.

---

## 7. CLI Surface

Thin wrappers over the same MCP calls, consistent with [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md) §1 ("the CLI is literally `mm` → MCP call → pretty-print").

```
mm refs to <path>           # who points at this
mm refs broken [--kind K]   # what's currently dangling
mm refs from <config>       # all outbound refs from one config file (debug)
```

No `mm refs fix`. Fixing is the agent's job, or the human's. The index is read-only by design.

---

## 8. Build Order

Sized as one slice. Each step is independently shippable; the index is useful after step 3 even without watcher integration.

1. Schema migration. Add `refs` and `ref_sources` tables to the existing SQLite database. Cost: low.
2. Scanner harness. Abstract the per-source parsers behind a `ReferenceScanner` interface that emits `{source, field, raw_value, target_path}` tuples. Wire one parser end to end (start with systemd units — INI-ish, deterministic, and the highest-impact source given today's break).
3. Parsers for the remaining four R1 sources. Order: gsettings, .desktop, crontab, shell rc. Shell rc is last because shell quoting is the worst parser. Validate each parser against the live machine and record findings in a `26a-references-validation.md` companion (mirrors the pattern set by [`docs/19-phase-1-validation.md`](./19-phase-1-validation.md)).
4. MCP tool registration. `mm_refs_to`, `mm_refs_broken`. Pretty-printing CLI wrappers.
5. Watcher hook. Subscribe to the existing inotify event stream; on `MOVED_FROM` / `DELETE`, re-validate affected rows.
6. Startup pass. On `mmd` start, run a full refs scan and emit a single log line summarizing broken counts by kind.

Steps 1–4 deliver the user-visible value. Steps 5–6 make it always-on.

---

## 9. Honest Limits

- **Parsers are per-format and need maintenance.** systemd directive variants change rarely; gsettings is stable; `.desktop` is well-specified; cron is ancient and stable; shell rc is the perpetual headache. Budget shell-rc parser bugs as a recurring tax, not a one-shot cost.
- **Indirection beats us.** A shell function that builds a path from `$VAR` interpolation is invisible to a regex-based scanner. A systemd unit that `EnvironmentFile=`s a path which itself references other paths requires recursion the first version does not do. Document these gaps in `26a-references-validation.md` as known false negatives rather than pretending to handle them.
- **System units are skipped.** `/etc/systemd/system/` and `/usr/share/...` references are read-only to the user anyway, and the failure mode (a system service breaks) is better surfaced by `journalctl` than by us. Defer to R3.
- **No write-back.** This index reports, never patches. If a future decision adds write-back (e.g. `mm refs migrate <old> <new>`), it gets its own decision log entry and its own safety story, because writing into `gsettings`, systemd units, and shell rcs is not symmetric — each has different rollback and side-effect properties.
- **The "moved to where" problem is unsolved here.** Detecting that a file at path A is now at path B requires either watcher cookie pairing (works for `mv` within a watched root) or content-hash matching against the existing index (works for cross-root moves). Slice 1 only flags brokenness; slice 2 can add fix-candidate suggestions using the existing FTS5 + content-hash index to answer "did this move?"

---

## 10. Why This Is Phase 1.5 And Not Its Own Phase

Per [`docs/23-product-v2-architecture.md`](./23-product-v2-architecture.md): every phase ships the same daemon + same CLI + same MCP server, progressively richer. References are one more index tier alongside FTS5, served by the same MCP server, watched by the same inotify pipeline. They do not need a roadmap pivot. They need a slice.

The pre-existing decision in `docs/13-decision-log.md` to defer "delete/rename detection as a scan-pass algorithm" (F-011) in favor of watcher events directly applies here: the references index relies on the same watcher, and gets re-validation for free.

---

## 11. Open Questions To Resolve Before Building

Recorded for [`docs/08-open-questions.md`](./08-open-questions.md) backfill, not blockers:

- Should `mm_refs_to(path)` accept a glob (e.g. `~/Pictures/wallpapers/*`)? Operationally common; trivial to add later.
- Should the MCP tool description nudge agents to call `mm_refs_to` *before* destructive ops? A description-level hint is cheap and may meaningfully change behavior.
- Snapshot-on-rescan semantics: when a config file is rewritten, do we delete the old `refs` rows and re-insert, or diff? Diffing preserves `last_checked_at` per ref but adds complexity. Default to delete-and-reinsert; revisit only if validation costs become a real load.
