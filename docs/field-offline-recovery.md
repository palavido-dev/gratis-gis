# Field-mode offline + recovery design

Status: design, drafted before Slices 4-6 as the contract those slices
honour, with "as built" notes where the implementation settled on
something simpler. Where this doc and the code disagree, the code
wins: `apps/portal-web/src/lib/offline-store.ts`, `offline-sync.ts`,
`public/sw.js` and `packages/shared-types/src/queue-replay.ts`. Last
revised 2026-09-08.

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
  /**
   * Stable id within this queue. UUID, but never user-facing.
   * As built this identifies the OPERATION, not the feature, so the
   * queue can hold more than one outstanding edit per feature. See
   * "Sync protocol" for why that matters.
   */
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
   * `failed` carries `failureReason` and is retried by the next
   * sync run; `rejected` (as built, 2026-09-03) carries the reason
   * too but is terminal: the server refused the edit for a reason a
   * retry cannot change, so nothing automatic touches it until the
   * worker retries or discards it from the runtime.
   */
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed' | 'rejected';
  failureReason?: string;
  /** ISO 8601, last sync attempt. */
  lastAttemptAt?: string;
  /** How many attempts have failed. Drives the retry backoff. */
  retryCount?: number;
}
```

Files captured in the field are NOT referenced from the queue record.
The sketch had an `attachments` array of blob ids on it; that field
was never populated and has been removed. As built, a captured file
is its own row in a `blobs` store,
keyed by the feature it belongs to (see the store table), and the
drain looks those rows up per feature after the feature write
succeeds. The queue record therefore needs no knowledge of them.

```ts
interface PendingBlob {
  /** Primary key. */
  blobId: string;
  dataCollectionId: string;
  /** The feature this belongs to. globalId is client-generated, so
   *  this resolves even before the insert has replayed. */
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** A real Blob, not base64. */
  blob: Blob;
  /** Capture time, not upload time. */
  capturedAt: string;
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
| `queue`             | `[dataCollectionId, id]`                   | Pending queue records, one per operation. Indexed `by_status` on `[dataCollectionId, syncStatus]` for the field UI's "show me pending / failed" filters, and `by_deployment` on `dataCollectionId`. |
| `blobs`             | `blobId`                                   | Photo/video Blob payloads captured before they could be uploaded (schema v2). Indexed `by_feature` on `[dataCollectionId, dataLayerId, layerKey, globalId]` and `by_deployment` on `dataCollectionId`. A row lives only until its upload has been registered. |

Schema v1 created the first five stores; v2 added `blobs` and touched
nothing else, which is the only reason the bump was safe on a device
holding unsynced captures. Bumps that rewrite an existing store need a
much harder look, because the rows at risk are exactly the field
captures this design exists to protect.

The deployments-manifest is the discovery root: any cleanup or
migration walks `deployments` first and fans out to the other stores
keyed off `dataCollectionId`. Removing a deployment cascades through
every store, `blobs` included.

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
changes via `navigator.onLine` + an explicit "Sync now" button). As
built there is a second drain: the service worker registers a one-shot
Background Sync (tag `gg-offline-queue`) on every queue write and
replays the queue with no tab open. Background Sync is Chromium-only,
so on iOS and Firefox the in-app drain is the only path. Both drains
read the same store and must apply the same rules, which is why those
rules live in one tested module, `packages/shared-types/src/queue-replay.ts`,
mirrored by hand in `public/sw.js` (marked there as a MIRROR).

### Capturing an edit: the fold

As built, an edit does not simply append a row. `enqueueEdit` in
`offline-store.ts` reads the feature's outstanding rows and, inside
ONE readwrite transaction, folds the new edit into the oldest one that
is `pending` or `failed`: an update over an unsent insert stays an
insert with the new attributes, a delete over an unsent insert removes
the row entirely (and the feature's pending files with it), several
edits to one feature cost one upload. The surviving row keeps the
oldest row's `id` and `queuedAt`, so the feature holds its place in
replay order, and its `retryCount` resets because new bytes deserve a
fresh attempt.

The single transaction is the point. IndexedDB serialises readwrite
transactions per store, so two enqueues racing (two taps, or a tap
during a drain) cannot both read the same prior row and each write a
fold of it, which would drop one edit. Before the fold existed the
queue was keyed one-row-per-feature and a second edit was a `put`
over the first: an insert edited before it synced became an update
against a globalId the server had never seen, took a 404, and parked
as permanently rejected. That was the first data-loss bug the audit
found.

Two statuses are never folded into: `syncing` (a drain owns the row
and would delete the merged result when its own replay succeeds) and
`rejected` (parked for a person to decide about; rewriting it would
discard their pending decision). An edit arriving in either case
becomes a second row for the feature, which is why the queue key is
the operation id and why replay has to be ordered per feature.

### Replaying: chain heads, claims, backoff

Each drain pass does the following.

1. **Pick the chain heads.** `queueChainHeads` lists at most ONE row
   per feature, the oldest by `queuedAt`, and only when that row is
   itself claimable. If a feature's oldest row is parked (`rejected`)
   or freshly in flight (`syncing`), every later row for that feature
   is skipped too: replaying it would send an update for a feature
   whose insert has not landed, 404, and park a second row. One
   blocked feature never holds up another. Heads are returned in
   `queuedAt` order across features, so replay still roughly follows
   capture order.
2. **Claim atomically.** `claimQueueRow` re-reads the row and flips it
   to `syncing` with a fresh `lastAttemptAt` inside one readwrite
   transaction, so of two concurrent claimants (the page and the
   worker) exactly one wins. Listing then writing in two transactions
   used to let both replay the same edit; only server-side idempotency
   hid it.
3. **Stale claims.** A row in `syncing` for longer than
   `QUEUE_CLAIM_STALE_MS` (two minutes, one value for both drains) is
   treated as abandoned by a page that died mid-drain or a worker the
   browser killed, and becomes claimable again. When the two drains
   had different windows, the shorter one stole rows the longer one
   still had in flight.
4. **Backoff.** A `failed` row waits out a ladder before it is
   claimable again, measured from `lastAttemptAt` and indexed by
   `retryCount`: 5 s after the first failure, then 15 s, 1 min, 5 min,
   capped at 15 min so a row that will succeed after a long outage
   still retries within a shift. There is no retry cap. A person
   pressing "Sync now" passes `manual`, which skips the wait. A
   network-level failure (fetch itself threw) is exempt: it means the
   radio is down, not that the row is bad, so the row's pre-claim
   status is restored and nothing is counted against it.
5. **Replay** the operation against the v3 features API, as below.

The original sketch of the wire protocol follows. For each record:

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

   **As built (2026-09-03).** The split is simpler than the sketch
   above and lives in one tested function,
   `replayOutcomeForStatus` in `packages/shared-types`, mirrored by
   hand in `public/sw.js`: 2xx is done, a 404 on delete is done,
   401/408/425/429 and every 5xx mark the row `failed` and it is
   retried on later runs subject to the backoff ladder above (no retry
   cap), and every other 4xx marks it `rejected`, which no drain
   touches again. `rejected` is the one terminal state: the server
   refused deterministically (validator, sharing, a conflict), so the
   same bytes would get the same answer. It leaves that state only by
   a person's hand, `retryRejected` (back to `pending`, reason and
   count kept) or `discardRejected` (row deleted, and the feature's
   pending files with it). There is no schema-diff or side-by-side
   conflict resolver; the server's message, unwrapped from the HTTP
   envelope, is shown as the reason. A synced row is deleted, not kept
   as `synced`.

   **Files.** After an insert or update lands, the drain uploads the
   feature's pending blobs (presign, PUT to object storage, register),
   deleting each only once the register call returned 2xx. A file that
   fails is left in place and the error propagates, so the row goes
   back to `failed` and the whole feature retries; reporting a record
   synced while its photo is still on the phone would be the worst
   available outcome. A file over the server's size limit is
   deterministic and parks the row `rejected`. A replayed delete drops
   the feature's files. At the end of a pass the in-app drain sweeps
   files whose feature has no queue row at all (an online save, which
   never touches the queue) and uploads them on their own, best
   effort. The service worker never uploads files: it skips any row
   whose feature still owes one and leaves those for the page, the
   same division the forms outbox uses.

Each op is independent. One failure does not block the rest, except
within a feature: a drain pass replays one row per feature, and a
feature whose head is parked or in flight is skipped entirely (see
"chain heads" above). Rows are processed one at a time in `queuedAt`
order; there is no per-layer parallelism.

## Recovery flows

### From the field runtime

The runtime header gains a status pill:
- "All synced" (green) — empty queue
- "N pending" (amber) — non-zero pending
- "N failed" (red) — any failures
- "Offline" (gray) — connectivity lost; queue grows but doesn't sync

As built, the header shows two chips instead of one pill: an amber
"Sync N" chip for retryable rows (tap to sync now, which skips the
backoff) and a red "N edits need attention" chip for rejected rows,
which opens a dialog listing each with its reason and Retry / Discard
actions (Discard confirms first). Photos and files still waiting to
upload count as unsynced work in the chip and in the sign-out warning.
The drawer described next is the original sketch.

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

As built, the admin surface is `/admin/field-queues`: a list of the
per-(user, device) manifest beacons the field client posts, so an
admin can see who has records stuck offline, how long a device has
been silent, and who is close to running out of storage. The record
payloads stay on the device by design; the admin's recourse is to
contact the worker. The envelope console below, with its per-record
replay and JSON editing, is the original sketch and has not shipped.

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
  blobs) + QR-code share for crew distribution. Shipped: files are
  captured to the `blobs` store against the feature's client-generated
  globalId, which exists from the moment the collect form opens, so a
  photo can be taken with no signal and before the record itself
  exists, and is uploaded once the feature lands (see "Files" under
  Sync protocol).

Once those land, the test that we got the design right is: an admin
can recover a stuck deployment without ever touching the user's
device, and the user can see why their edits failed without
reading log files.
