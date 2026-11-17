# Presence Phase 2 CRDT defaults (2026-11-03)

Locked when Matthew yay'd `R1-presence-crdt / R5-presence-crdt`.
These are the abuse and transport defaults the Developer uses
without a further morning round (same pattern as comment
`@mentions`).

## Product intent

Two signed-in people edit the **same markup set** on a map without
last-write-wins clobber. Presence cursors (Phase 1 / 1.5) stay as
they are. Layers / styles / viewport CRDT stay deferred.

## Defaults

| Decision | Default |
| --- | --- |
| Who may write a CRDT room | Signed-in author of the set, or a map editor (`assertCanWriteSet`) |
| Who may observe | Anyone who `canRead` the map (same as presence) |
| Anonymous CRDT | **Off.** Anon markup stays REST LWW even when `allowAnonymousDrawings` is on |
| Transport | Nest native `ws` sibling path `/api/realtime/drawings-ws` (not a separate y-websocket process) |
| Auth | Opaque short-lived ticket minted over the BFF; JWT never on the WS URL; ticket binds `mapId` + `drawingSetId` + role |
| Multi-replica | In-memory rooms only (same as presence). Redis later |
| Persistence | `item.data.drawings` remains source of truth; debounced snapshot after updates / on disconnect |
| Inbound frame cap | **256 KiB** for drawings WS (presence stays 64 KiB) |
| Update rate | About **30 updates/s** per connection |
| Ticket mint | **30/min** (match presence) |
| HTTP CRDT fallback | **None.** If WS fails, fall back to today's REST LWW; do not pretend merge works |
| Reconnect | Resync from Yjs state vector / REST snapshot; rooms drop after idle |
| Feature shape | Y.Map of features keyed by feature id (JSON value); concurrent edits to different features merge |

## Out of this vertical

Redis fanout, anon CRDT, offline-first merge, awareness beyond
existing presence cursors, CRDT for map layers/styles/viewport.
