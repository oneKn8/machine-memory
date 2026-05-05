# mm_subscribe — streaming MCP tool design (Phase 4)

> **Status:** Design only. No `registerTool('mm_subscribe', …)` call lands in Slice 3. Phase 4 (conversational layer) implements the per-client subscription state and the MCP tool registration. This doc locks the surface NOW so Phase 4's implementer is not re-deriving it under deadline pressure.

## 1. Motivation

Polling `mm_recent` is wasteful for an agent that wants to react to file events. The watcher (Slice 3) already produces an in-process event stream; `mm_subscribe` exposes that stream to MCP clients so an agent can react to "user just saved a markdown note in `~/projects/foo/`" without polling. Removes one excuse for ignoring `mm_*` (per `docs/27` G-1) by giving agents an event-driven hook.

## 2. Tool surface

### Input schema

```ts
{
  path_prefix?: string                              // filter: only events whose path starts with this prefix
  kinds?: Array<'file_modified' | 'file_added' | 'file_deleted' | 'file_renamed'>  // default: all four
  since?: string                                    // ISO 8601 datetime; replay events after this point (Phase-4 caveat — see §5)
}
```

All fields optional. Empty input streams every event under the daemon's scan roots.

### Output (streaming)

The MCP SDK's `StreamableHTTPServerTransport` supports streaming responses. The tool emits one chunk per event:

```ts
{
  kind: 'file_modified' | 'file_added' | 'file_deleted' | 'file_renamed'
  path: string
  ts: string                            // ISO 8601, when the daemon observed the event
  // Rename events carry both:
  old_path?: string                     // present when kind === 'file_renamed'
  // Optional metadata, present when cheap:
  size_bytes?: number
  modified_at?: string
}
```

For stdio transport (no streaming response) the tool returns a single result containing `events: WatcherEvent[]` collected during a server-bounded window (e.g., 5 s) — agents using stdio that want continuous events poll the tool repeatedly with `since` set to the timestamp of the last event they saw.

## 3. Backpressure

The SDK's streaming transport gives us flow control via the underlying HTTP response body. The tool's emitter pushes events into the response; if the client is slow, the response's `drain` event signals when to resume. Concretely:

- Daemon-side, each subscription holds a bounded in-memory buffer (proposed: 1000 events). When the buffer is full and the response stream is not drained, we drop events from the buffer **head** (oldest) and increment a per-subscription `dropped_events_total` counter exposed via `_status`.
- The dropped-events behavior is the inverse of the writer queue's policy in Slice 3 (which drops oldest into a dirty-paths set so the index can self-heal). For subscribers, dropping oldest means "you missed some events, but the most recent are still accurate." Subscribers who care about completeness MUST track `dropped_events_total` and resubscribe with a `since` window when it grows.

## 4. Transport applicability

| Transport | Stream model | Behavior |
|---|---|---|
| HTTP (`StreamableHTTPServerTransport`) | Real streaming (chunked or SSE-ish) | Tool returns a streaming `CallToolResult` with one event per chunk. Connection persists until the client disconnects or the daemon shuts down. |
| stdio (`StdioServerTransport`) | One JSON-RPC notification per event | Tool returns a single `CallToolResult` containing `events[]` for the bounded window described above. Agents that want continuous coverage poll. |

Both transports route through the **same** daemon-side event emitter (the watcher's existing in-process `EventEmitter`). The MCP layer is a per-client adapter on top.

## 5. Lifecycle

- **Subscribe.** Client calls `mm_subscribe`. The MCP server allocates a subscription record `{id, filter, buffer, droppedCount, transport}` and attaches a listener to the watcher's emitter.
- **Disconnect.** When the response stream closes (HTTP keepalive drop, client `abort`), the MCP server detaches the listener, frees the buffer, and removes the subscription record. No reference leaks.
- **Daemon shutdown.** On `server.close()`, the MCP server closes every active subscription stream cleanly (sends a final empty chunk + closes the response). Subscribers should treat this as a normal end-of-stream and re-establish on the next daemon start (with `since` set to their last-seen timestamp).
- **Stale GC.** Every 60 s the daemon walks active subscriptions; any whose response object is `.destroyed === true` (HTTP socket closed without a clean disconnect) is removed.

## 6. `since`-based replay — Phase 4-or-later caveat

The internal event emitter (Slice 3) does NOT persist events. `since` is honored only against events the daemon has emitted **since boot**. If a daemon restarts at T=10:00 and an agent subscribes at T=10:05 with `since=09:30`, the daemon CANNOT replay the missing 30 minutes — it returns only events from T=10:00 forward.

True cross-restart `since` requires the `activity_events` table (Phase 2). Until that exists, `mm_subscribe` documents this caveat in its tool description and returns events from the daemon's lifetime only.

## 7. What Slice 3 ships vs what Phase 4 ships

| Concern | Slice 3 | Phase 4 |
|---|---|---|
| Watcher event source | ✓ (`src/daemon/watcher.ts`) | — |
| In-process event emitter | ✓ (the watcher's `onEvent` callback) | — |
| Per-client subscription state | — | ✓ |
| MCP tool registration | — | ✓ |
| `since` replay across restarts | — | Deferred to Phase 2 (`activity_events` table) |
| Buffer / drop policy + counter | — | ✓ |
| `mm_subscribe` tool description + Zod schema | — | ✓ |

Slice 3's contribution is the substrate: a watcher whose events flow through a debouncer to the writer queue. The same emitter that feeds the debouncer can fan out to subscriptions in Phase 4 — no rework of the watcher itself is needed. This is the load-bearing reason `mm_subscribe` is design-only here: shipping the implementation now would drag in subscription lifecycle, drop-policy semantics, and stdio polling-window tuning before the daemon even has a stable event source to expose.

## 8. Out of scope for this design

- Per-event filtering by content (e.g., `text_match=foo`) — Phase 5+.
- Event aggregation (e.g., "five edits to file X within 1 min" → single chunk) — done at the agent layer if needed.
- Cross-daemon federation — single-user, single-machine for v1.
- Schema versioning of the event payload — when needed, add `schema_version: 1` to the chunk shape.
