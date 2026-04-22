# Phase 1 Slice 2 Validation

**Dated:** 2026-04-19.
**Host:** Linux 6.17.9-76061709-generic.
**Slice:** Phase 1 Slice 2 — MCP server (stdio bridge + HTTP transport in daemon).
**Branch:** `phase-1-slice-2`.

This file records the real-machine ship-bar check required by Task 8 of `docs/plans/2026-04-19-phase-1-slice-2-mcp-server.md`. Slice 1's analogous record lives at `docs/24-phase-1-slice-1-validation.md`. Where Slice 1 proved socket parity for the CLI, this slice proves transport parity for MCP: a real `@modelcontextprotocol/sdk` `Client` reaches the same `createMcpServer` core through both the stdio bridge and the in-daemon Streamable HTTP endpoint, and those two paths return byte-identical `structuredContent`.

## Index Size At Validation

Captured directly from `~/.local/share/machine-memory/machine-memory.sqlite` at run time:

| Table          | Count  |
| -------------- | ------ |
| `file_records` | 20,000 |
| `repo_records` | 90     |
| `text_blobs`   | 18,244 |

DB file size: ~402 MB. This is the same live local index used by Slice 1's validation — no rescan was performed for this slice, on purpose, so the `thesis` query is directly comparable to Slice 1's record.

## Build Under Test

- Branch: `phase-1-slice-2`.
- Slice 2 commits (in order):
  - `9bd9b0d` — Task 1: string-id guard (carry-over from Slice 1).
  - `8311426` — Task 2: pin `@modelcontextprotocol/sdk`.
  - `00720d7` + `b9a912c` — Task 3: `createMcpServer` factory + tests.
  - `4d55396` + `06c1eb5` — Task 4: stdio bridge `mmd-mcp` + tests.
  - `9150af1` — Task 5: HTTP MCP transport mounted in daemon (loopback only).
  - `86fce4d` — Task 6: `mmd-mcp` bin entry + `npm run mcp dev` script.
  - `d2fcf27` — Task 7: D-023 + D-024 logged.
- `npm run build`: clean (exit 0).
- `npm run typecheck` and `npm test` were last run clean as part of Tasks 3–6; no source under `src/` or `tests/` was modified for this validation, so those gates still hold.

## Discovery URL Captured

On daemon start (`nohup node dist/daemon/server.js`), `~/.local/share/machine-memory/mcp.url` was written with:

```
http://127.0.0.1:41907/mcp
```

Shape matches D-024: loopback host (`127.0.0.1`), ephemeral port chosen by the OS, mounted at the `/mcp` path. `mmd.sock` was created in the same directory in the same step.

## Stdio Bridge Results

A real SDK `Client` was instantiated with `StdioClientTransport({ command: 'node', args: ['dist/mcp/stdio.js'] })`, then `listTools()` and `callTool()` were issued against it. Output captured to `/tmp/mm-mcp-stdio.json`.

- Tools advertised (3): `mm_find`, `mm_get`, `mm_recent`. Descriptions match `createMcpServer`'s registrations verbatim.
- `mm_find` with `{ query: "thesis" }` returned a `structuredContent.results` list. Top hit:
  - `id`: `cdff44904648dde84e3c2ce97f666f1bf2d266d8`.
  - `kind`: `file`.
  - `path`: `/home/oneknight/projects/machine-memory/docs/01-product-thesis.md`.
  - `title`: `01-product-thesis.md`.
  - `score`: `227`.
  - `why_matched`: includes `Matched indexed text: # Product [Thesis] …`.
- `content[]` carried at least 3 `resource_link` entries, the first three of which were `01-product-thesis.md`, `RIEMANN_HYPOTHESIS_PROOF.md`, and `riemann_hypothesis_analysis.md`. Each had a `file://` URI pointing at the real on-disk path.
- `mm_get` against the top id returned `record.kind = "file"` and `record.blobs.length = 1`.

This is the same `01-product-thesis.md` top hit that Slice 1's parallel `mm find thesis` would surface on this index, so the result is consistent with the existing CLI-path baseline.

## HTTP Transport Results

A real SDK `Client` was instantiated with `StreamableHTTPClientTransport(new URL(<discovery url>))` — i.e. the URL was read from `~/.local/share/machine-memory/mcp.url` rather than hardcoded, exercising the discovery contract end to end. Same `listTools()` / `mm_find` / `mm_get` calls, output captured to `/tmp/mm-mcp-http.json`.

- Tools advertised (3): `mm_find`, `mm_get`, `mm_recent`. Identical names and descriptions as the stdio path.
- `mm_find` top hit: identical id (`cdff44904648dde84e3c2ce97f666f1bf2d266d8`), identical path, identical score, identical `why_matched`.
- First three `resource_link` entries: identical names and URIs.
- `mm_get` against the top id: `record.kind = "file"`, `record.blobs.length = 1` — identical.

## Parity Diff

```
diff /tmp/mm-mcp-stdio.json /tmp/mm-mcp-http.json
```

Result: **empty diff**. Both transports went through the same `createMcpServer` core and the same `MachineMemoryService` against the same index, so this matches the design intent recorded in D-023.

## Daemon-Down Bridge Behavior

After `node dist/cli/main.js daemon stop`:

- `~/.local/share/machine-memory/mcp.url`: gone (`ls` reports `No such file or directory`).
- `~/.local/share/machine-memory/mmd.sock`: gone.
- `node dist/mcp/stdio.js` (run with no daemon): exit code **1**, stdout empty, stderr was a single line:

  ```
  mmd-mcp: daemon not running at /home/oneknight/.local/share/machine-memory/mmd.sock. Start it with `mm daemon start` (or run `mmd` directly), then re-launch this MCP server.
  ```

This matches the stdio bridge's contract: it must not silently appear "connected but useless" to a calling MCP host, and it must point the operator at the recovery action.

## Discovery File Lifecycle Observed

- Before `daemon start`: `mcp.url` absent.
- After `daemon start` (this run): `mcp.url` present with `http://127.0.0.1:41907/mcp`, mode `0644`, written atomically by the daemon on listen.
- After `daemon stop`: `mcp.url` absent again. No stale file left behind.

This matches D-024's atomic-write + unlink-on-shutdown contract.

## Slice 2 Ship Bar

From `docs/plans/2026-04-19-phase-1-slice-2-mcp-server.md` "Ship bar":

- [x] Real MCP `Client` connects via stdio bridge AND lists 3 tools AND calls `mm_find`.
- [x] Real MCP `Client` connects via HTTP discovery URL AND lists 3 tools AND calls `mm_find`.
- [x] Schema-valid response with at least one `resource_link` in `content[]` (3 captured per call, both transports).
- [x] Discovery file written on startup, removed on shutdown, has `http://127.0.0.1:<port>/mcp` shape.
- [x] All Slice 1 tests still pass (no `src/` or `tests/` change in this slice's validation; Tasks 3–6 already kept the suite green when each landed).
- [x] `mm find` / `mm show` / `mm daemon` parity from Slice 1 still works (the daemon was up and serving the same socket the CLI uses; the stdio bridge talks to that socket too).
- [x] `npm run typecheck` and `npm run build` clean (build re-run as part of this validation; typecheck last clean on `d2fcf27`).

## Verdict

**Status:** Verified complete. Slice 2 ships.

Both MCP transports work end to end against the real local index, return identical `structuredContent`, surface real `file://` resource_links the calling host can fetch, and the discovery file behaves correctly across the daemon lifecycle. The bridge fails closed and loud when the daemon is down.

## Follow-ups Surfaced By This Validation

- F-014 (new): the in-daemon HTTP transport currently picks an ephemeral port at startup. That is correct for local-only use (D-024), but means an MCP host that caches the URL across restarts will see a different port each time. When Slice 4 lands the install/runbook, document that hosts must re-read `mcp.url` after any `mmd` restart, or add a `--mcp-port` flag if a stable port becomes useful.
- F-015 (new): both transports share the same `createMcpServer` factory, so any change to tool schemas only needs to be tested once — but this validation only exercised the happy path. A future hardening slice should add a transport-parity property test that fuzzes a small set of `mm_find` / `mm_get` calls and asserts byte-equal `structuredContent` automatically, so this manual diff doesn't have to be re-run by hand each ship.
- No protocol drift, no schema drift, no encoding drift between the stdio bridge path and the in-daemon HTTP path was observed. Confidence is high that the two transports are true peers over the same core.
