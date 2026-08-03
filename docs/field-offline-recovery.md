# Field-mode offline + recovery design

Status: design — drafted before Slices 4-6 implementation as the
contract those slices honour. Last revised 2026-04-30.

## Why this doc exists

Esri's offline workflow for Survey123 / Field Maps has one durable
gap: when sync fails, the user's recovery path is awful. They plug
their device into a PC, navigate app-private folders, hunt for runtime
geodatabase or sqlite files named with opaque GUIDs, and try to sync
them via ArcGIS Pro. When that doesn't work either, they have to
inspect features one-by-one and manually replay edits as appends and
replaces against the source data. We have decades of evidence that
this is the worst part of the offline story for collectors AND for
the GIS staff who support them.

We're starting fresh. We can pick a different model. The point of
this doc is to nail the design constraints before any offline code
ships, so we don't accidentally inherit the same shape just because
sqlite-on-device is the default vendor cookbook.

The single sentence that drives every decision below:

> A user should never need to plug a device into a PC to recover their
> field-collected data.

## Design principles

These are the load-bearing decisions. Everything in the implementation
sections follows from them.

### 1. The on-device queue is human-readable JSON

The pending-edits queue lives in IndexedDB as JSON, not in an
embedded geodatabase or sqlite file. Every record is inspectable in
plain text. A field tech opening their browser DevTools can see
exactly what's pending, in the same shape an admin would see on the
recovery console.

### 2. Filenames + identifiers are human-readable

When the queue is exported, it's named
`pending-<deployment-slug>-<username>-<YYYY-MM-DD>.json`, not a UUID.
Internal database keys can use UUIDs but anything a user or admin
ever reads — filenames, page titles, log lines — stays
human-readable.

### 3. Recovery doesn't depend on sync succeeding

The primary recovery action is **not** "retry the failing sync." It's
"export this queue to the portal as a stuck-queue report, untouched,
without applying any edits to the data layers." If sync is broken
because of a bad schema migration or a bug in our code, the user can
still get their data to us with one tap. They can keep collecting.

### 4. Per-edit failure isolation

A bad edit in position 17 must not block the 199 edits behind it from
syncing. Each operation is sent independently and gets its own
sync-status (synced / failed / pending) in the local queue, plus the
server's failure reason inline. The user sees a clear list of which
3 of 200 edits didn't go through and why, not a generic "sync
failed."

### 5. Schema diffs are surfaced, not coerced

The deployment captures a schema hash for each editable layer at
download time. At sync time, the server compares the operation's
expected schema against the current one. Differences are surfaced
inline ("severity field removed; you have 3 edits that wrote to it —
keep / drop / map to other field?") and the user picks. Never silent
coercion, never silent drop.

### 6. Conflicts are field-level and visual

When a feature was edited offline AND on the server while the user
was offline, both changes are surfaced as a per-field side-by-side
diff with keep-mine / keep-theirs / merge controls. Last-write-wins
can be the auto-resolution default for conflicts the user opts into,
but it's never silent.

### 7. Admins recover, users don't

The org admin owns a `/admin/stuck-queues` page that lists every
pending queue across users, with per-edit failure reasons, the option
to edit the queue's JSON in-place to fix one stuck edit, replay
individual operations, mark queues abandoned with a reason, or export
to CSV. The recovery console comes to the data — the data doesn't
have to leave the system to be recovered.

### 8. Storage budgets are explicit

IndexedDB on browsers is bounded; we can't blindly cache. The
deployment's `offline.bbox` + zoom range determine how many basemap
tiles + feature rows we'll cache. The download flow estimates the
total size up front and refuses to start past a budget (or asks the
user to confirm). No silent truncation when the quota is hit
mid-download.

## Data shapes

### Queue record

```ts
interface QueueRecord {
  /** Stable id within this queue. UUID, but never user-facing. */
  id: string;
  /**
   * Operation kind. The shape of the rest of the record depends on
   * this discriminator.
   */
  op: 'insert' | 'update' | 'delete';
  /** Layer the op targets. */
  dataLayerId: string;
  layerKey: string;
  /**
   * Feature global_id. For inserts the client mints this so we can
   * survive offline-then-sync and have a stable feature identity
   * across devices (the server respects whatever global_id the
   * client supplied). For updates / deletes this is the existing
   * feature's global_id from the cached features table.
   */
  globalId: string;
  /** Geometry for inserts and updates. Null for deletes. */
  geometry: GeoJSON.Geometry | null;
  /**
   * Properties for inserts and updates. For updates we send the
   * full new property set; the server replaces wholesale and stamps
   * a new version row. Diffs against original happen at conflict
   * resolution time, not on the wire.
   */
  properties: Record<string, unknown> | null;
  /** Wall-clock when the operation was queued, ISO 8601. */
  queuedAt: string;
  /**
   * Schema hash captured when the op was queued. Lets the server
   * detect a schema-vs-edit diff at sync time. SHA-256 of a
   * canonical-JSON serialisation of the layer's FeatureField[] (see
   * `hashLayerSchema`).
   */
  schemaHash: string;
  /**
   * Sync state. `pending` is the default; `syncing` is set while a
   * single op is in flight; `synced` clears the op from the queue
   * (kept briefly for UI confirmation, then garbage-collected);
   * `failed` carries `failureReason` and stays in the queue until
   * the user takes action on it.
   */
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed';
  failureReason?: string;
  /** ISO 8601, last sync attempt. */
  lastAttemptAt?: string;
  /** Attachment refs (slice 6); not populated in slice 5. */
  attachments?: Array<{
    /** Local blob id in the offline-attachments store. */
    blobId: string;
    /** MIME type, used to label the attachment server-side. */
    mimeType: string;
  }>;
}
```

### Stuck-queue export envelope

What the "Send to admin" action POSTs to the portal, and what the
"Export to file" action serialises:

```ts
interface StuckQueueEnvelope {
  /** Magic header so the admin importer can sniff. */
  kind: 'gratisgis-stuck-queue';
  /** Schema version of this envelope. Bump on breaking change. */
  version: 1;
  /** Deployment id this queue collected against. */
  dataCollectionId: string;
  /** Deployment slug at time of export (for the human filename). */
  dataCollectionSlug: string;
  /** Username at time of export (for the human filename). */
  username: string;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /**
   * Optional client-supplied note. The export UI offers a free-text
   * field "Anything the admin should know?" — useful for context like
   * "stuck since 2026-04-25, schema migration broke sync."
   */
  note?: string;
  /** The records, in the order they were queued. */
  records: QueueRecord[];
  /**
   * Schema snapshots captured when the user went offline, keyed by
   * "<dataLayerId>:<layerKey>". Lets the admin reproduce the
   * client's expected shape during recovery.
   */
  schemaSnapshots: Record<
    string,
    {
      schemaHash: string;
      fields: Array<{
        name: string;
        type: string;
        nullable?: boolean;
        domain?: unknown;
      }>;
    }
  >;
}
```

### IndexedDB object stores

We use one IndexedDB database per portal origin, named `gratisgis-offline`.
The stores below are scoped by deployment id where applicable so multiple
deployments cached on one device don't collide.

| Store               | Key (composite path)                       | Notes |
|---------------------|--------------------------------------------|-------|
| `deployments`       | `dataCollectionId`                         | Manifest: which deployment is cached, when, schema snapshots, bbox, zoom range, total size estimate. |
| `features`          | `[dataCollectionId, dataLayerId, layerKey, globalId]` | Cached features per editable layer. Indexed by `[dataCollectionId, dataLayerId, layerKey]` for "give me all features of layer X" queries. |
| `forms`             | `[dataCollectionId, formItemId]`           | Bound form schemas. |
| `pickLists`         | `[dataCollectionId, pickListItemId]`       | Pick-list contents. |
| `queue`             | `[dataCollectionId, recordId]`             | Pending queue records. Indexed by `[dataCollectionId, syncStatus]` for the field UI's "show me pending / failed" filters. |
| `attachments`       | `[dataCollectionId, blobId]`               | Photo/video Blob payloads. (Slice 6.) |

The deployments-manifest is the discovery root: any cleanup or
migration walks `deployments` first and fans out to the other stores
keyed off `dataCollectionId`.

## Service worker strategy

The portal-web service worker (registered at root scope) intercepts
two URL classes:

1. **GeoJSON reads** —
   `/api/portal/items/<itemId>/layers/<layerKey>/geojson` (and the
   legacy item-level form, both paths v3 falls back to). When the
   user is offline AND the requested layer's features are cached for
   an active deployment, we serve a synthesised FeatureCollection
   from the `features` store. Otherwise we fall through to the
   network. The response carries an `X-GratisGIS-Source: offline`
   header so the runtime can show an "offline data" indicator.

2. **Tile reads** — basemap tile URLs (style-url + xyz tile patterns
   resolved at download time). We pre-cache a window of tiles for
   the deployment's bbox and zoom range using the Cache API. Tiles
   outside the cached window fall through to the network when
   online; offline they 404 (the canvas shows empty tiles, rather
   than incorrect ones from another extent).

The service worker does not intercept POST / PATCH / DELETE on
features. Those go directly to the queue manager in the field
runtime; no fetch is made until sync time. This keeps the worker's
behaviour predictable: reads can be served offline, writes always
go through the explicit queue.

## Sync protocol

Sync runs when the runtime detects connectivity (online/offline state
changes via `navigator.onLine` + an explicit "Sync now" button).

For each pending queue record, in queue order:

1. Set `syncStatus = 'syncing'`, stamp `lastAttemptAt`.
2. POST / PATCH / DELETE the operation against the v3 features API.
   The op is sent with an extra `x-gratisgis-schema-hash` header so
   the server can compare against the current layer schema.
3. **Server side**: compare hash against current schema. If equal,
   apply normally. If different, run a structural diff:
   - Pure additions to schema (new optional column): apply the op,
     attach a `warnings` array to the response listing the new
     columns the client didn't know about (informational).
   - Field removed: refuse the op with `409 schema-mismatch`,
     response body lists the fields the client wrote to that no
     longer exist plus suggested resolutions.
   - Field renamed (heuristic match: same type, similar name): same,
     response includes a suggested rename mapping the client can
     apply automatically with user confirmation.
   - Type change: same, no automatic resolution.
4. **Client side** on response:
   - 2xx: `syncStatus = 'synced'`, garbage-collected after 30s. The
     features cache is updated with the server's authoritative
     row (geometry, properties, _global_id) so subsequent reads
     reflect the new state without a re-fetch.
   - `409 schema-mismatch`: `syncStatus = 'failed'` with the
     server's diff payload as `failureReason`. The user gets a UI
     surface to resolve per-field.
   - `409 conflict` (someone else edited the same feature on the
     server while we were offline): `syncStatus = 'failed'` with the
     server's current row in the failure payload. The user gets the
     side-by-side conflict resolver.
   - 4xx other: `syncStatus = 'failed'` with the body as the
     reason. No automatic retry.
   - 5xx: `syncStatus = 'pending'` again (transient server error;
     retry on next sync run). Bump a `retryCount` field; if it
     passes 5, mark `failed` with "max retries exceeded."

Each op is independent. One failure doesn't block the rest. The
runtime processes the queue sequentially per layer (so two updates
to the same feature land in order) but parallel across layers.

## Recovery flows

### From the field runtime

The runtime header gains a status pill:
- "All synced" (green) — empty queue
- "N pending" (amber) — non-zero pending
- "N failed" (red) — any failures
- "Offline" (gray) — connectivity lost; queue grows but doesn't sync

Tapping the pill opens a queue review drawer:
- A list of every record with status icon + timestamp + summary
  ("Add Nest at -117.04,33.79", "Edit Inspection #abc...")
- Per-record actions: "Retry now", "Discard this edit", "Edit
  payload" (for the desperate case)
- Footer actions: "Sync now" (manual trigger), "Export to file"
  (downloads the StuckQueueEnvelope JSON), "Send to admin"
  (POSTs the envelope to `/admin/stuck-queues` and clears the
  local queue on success — the user's data has reached us;
  recovery is now an admin task).

### From the admin recovery console

`/admin/stuck-queues` is org-admin-only. Lists every envelope
across the org with: deployment, user, exported-at, record count,
note, status. Click into one:

- Per-record table with status icons + per-field expand/collapse
- Replay-individual button (re-queues the op against the
  current layer schema and reports back the result inline)
- "Edit JSON" surface (textarea showing the envelope; admin-side
  changes get persisted; useful for one-off recovery like "set
  severity=null for these 3 records since the column was dropped")
- Discard button per record
- Mark-abandoned at the envelope level with a reason
- Export-to-CSV at the envelope level for off-portal review

### From a bare JSON file

The exported file IS the envelope. An admin can import it back
into `/admin/stuck-queues` via an "Import envelope" button without
needing the user to have direct portal access. Useful for the
"my collector's phone died, here's the last queue I synced from
their device" workflow.

## Storage budgets

The download flow estimates size before fetching:

- **Features**: estimated as `featureCount * avg_bytes_per_feature`.
  Backstop: cap at the smaller of (estimated 50 MB) or (server's
  max-features-per-area limit).
- **Forms + pick lists**: trivial. Always fetched.
- **Tiles**: dominant cost. For a bbox at zoom levels minZoom..maxZoom
  the tile count is `sum_z(ceil(width_z) * ceil(height_z))`. We
  estimate at ~25 KB per tile. Cap defaults: 100 MB. If a deployment's
  config asks for more, the download UI shows the projected size and
  asks the user to confirm.

The IndexedDB total free space is queried via
`navigator.storage.estimate()`. We refuse to start a download whose
estimated size would exceed `quota - 50 MB` headroom. On quota error
mid-download we surface a clear "ran out of space, X% of features
downloaded" message rather than silently truncating.

## Security considerations

- **Queue contents may include sensitive attribute data.** Queues
  are stored in IndexedDB scoped to the portal origin, served only
  over HTTPS in production. Browser sandboxing prevents other
  origins from reading them.
- **The "Send to admin" endpoint requires authentication.** The
  user's session cookie / token is included in the POST. The
  endpoint validates the user is a member of the deployment's
  org and writes the envelope keyed to `(orgId, userId, exportedAt)`.
- **Stuck queues may outlive their author's session.** They persist
  on the server until an admin discards them. Standard data-retention
  rules apply; admins should be able to set per-org retention via
  the housekeeping config.
- **The admin "Edit JSON" surface is auditable.** Every edit to a
  queue's JSON gets logged with `(adminUserId, before, after, at)`
  so the audit trail is preserved through recovery actions.

## Slice phasing

These principles roll out across three implementation slices:

- **Slice 4 (#198 candidate)**: Offline data download + service
  worker + IndexedDB foundation. Covers the read path (cached
  features, cached forms, cached pick-lists). Tile caching is
  best-effort; map renders without it albeit ugly.
- **Slice 5 (#199 candidate)**: Queue + sync + per-edit isolation +
  schema-diff detection + Send-to-admin + admin stuck-queues page.
  This is the meat of the recovery story.
- **Slice 6 (#200 candidate)**: Attachment offline (photo/video
  blobs) + QR-code share for crew distribution.

Once those land, the test that we got the design right is: an admin
can recover a stuck deployment without ever touching the user's
device, and the user can see why their edits failed without
reading log files.
