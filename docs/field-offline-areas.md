# Field offline: catalog, areas, and resilience

Companion to `docs/field-offline-recovery.md`. That doc covered the
queue + sync + manual recovery story. This one covers the surfaces
above and below it: how a user finds the deployments they care about,
how an admin pre-generates ready-to-download snapshots so workers
don't all hammer the same fetch loop on day one, how cache eviction
and storage limits get surfaced and managed, and how all of this is
arranged so the system has multiple failure-tolerant paths back to
the user's data.

**One non-negotiable:** field data is not allowed to disappear.
Workers spend hours collecting it, often in places where redoing the
work is expensive or impossible. A field tool that loses a tide
gauge reading because the browser cache got nuked is broken in a way
that erodes trust forever. Every design choice below is filtered
through "does this give us another recovery path or does it remove
one?"

## Design principles

1. **Never silently drop a record.** Every queued edit has at least
   two independent persistence paths before it's considered safe.
   When one fails, the others are still there.
2. **Surface state before failure, not after.** The user should see
   "you have 47 unsynced edits, 12 MB cached, browser may evict in
   X conditions" before it matters, not when it's already gone.
3. **Recovery should feel boring.** If a worker walks back into
   wifi after three days offline, sync should be one tap, with no
   technical understanding required. The hard cases (stuck queues,
   cache evictions, version mismatches) should be admin-tier
   surfaces, not user-tier puzzles.
4. **No permission to ask once and forget.** Persistent storage,
   notification access, geolocation, and (eventually) PWA install
   are all asked for at the moment of relevance with a clear "why
   we need this," and re-asked if revoked.
5. **Explicit over implicit.** No background "we hope this synced"
   states. Either the record is on the server or it's still in the
   queue, and the UI says which.
6. **Pre-generation beats on-demand for known areas.** When the
   admin can tell us in advance which polygon a crew will be
   working in, the snapshot is ready; the field tool reads it in a
   single network call instead of fanning out to N layer endpoints.
7. **Pre-generation never replaces on-demand.** A worker who needs
   a snapshot of an area the admin didn't anticipate can still
   draw a polygon and grab one, exactly like today.

## Storage tiers and the resilience ladder

The field client persists data across a stack of tiers. Each tier
catches what the one above it misses. The goal is that no single
clear / wipe / device-loss event can erase a worker's contribution.

```
Tier 0: Active session memory
        |  Lost on tab close. We never trust it.
        v
Tier 1: IndexedDB, default ("best effort") storage
        |  Survives tab close. Browser may evict under disk pressure.
        v
Tier 2: IndexedDB with navigator.storage.persist() granted
        |  Browser will not auto-evict. Only an explicit user "clear
        |  site data" removes it.
        v
Tier 3: PWA install (service worker + manifest)
        |  OS treats the data like an installed app. iOS lifts its
        |  ~1 GB ceiling. Android resists eviction even harder.
        v
Tier 4: Server-side queue manifest mirror
        |  Periodically POSTed lightweight record so the admin can
        |  see queue state for every device, prompt re-sync, or
        |  walk a stuck worker through recovery.
        v
Tier 5: User-initiated export / QR / file-based handoff
        |  Last-resort manual path covered in
        |  field-offline-recovery.md. Always available even when
        |  the device is offline forever.
```

**What we ship today:** Tier 1 only (basic IndexedDB) plus the
file-export rescue path. That's a single-failure-away-from-data-loss
configuration. Tiers 2 through 4 are the work this doc proposes.

### Tier 2: persistent storage

`navigator.storage.persist()` is a one-line call that asks the
browser for a "this site's data is important" guarantee. Once
granted, the browser will not reclaim the storage under disk
pressure. It still goes if the user explicitly clears site data.

Implementation: call it the moment a download begins, not on page
load. The prompt's "Allow [site] to keep data on your device?"
copy reads better when the user has just chosen to download
something for offline use; asking on a cold landing reads as a
permissions ambush.

The grant survives across page loads. We check
`navigator.storage.persisted()` at field-runtime mount and surface
a one-line warning chip if it's not persisted, with a "Make
persistent" button that re-prompts.

### Tier 3: PWA install

A web app manifest plus a minimal service worker turns the field
tool into something the OS treats more like a native app. Two
benefits:

1. **iOS Safari** caps web storage at ~1 GB by default. PWAs
   installed to Home Screen lift that ceiling significantly.
   Without this, an iOS user attempting a serious offline area
   download is going to hit the wall and not understand why.
2. **Android Chrome** treats installed PWAs as more "important"
   for storage retention; the OS reclaims their data later when
   the device is under pressure.

The service worker also unlocks tile pre-caching at the basemap
layer (today the field map renders empty tiles offline because
MapLibre has no service-worker-aware cache). Tile caching is the
single biggest UX improvement we can make for offline workers
beyond the resilience story.

We surface an "Install for offline use" banner the first time a
user downloads a deployment, with copy that explains why
("installing makes the app survive cache clears and frees up more
device storage"). The banner is dismissable but reappears when a
new download begins on a non-installed device.

### Tier 4: server-side queue manifest mirror

Every N minutes, while online, the client POSTs a lightweight
manifest to a new endpoint:

```
POST /api/portal/field/queue-manifest
{
  deviceFingerprint: <stable hash, no PII>,
  userId: <uuid>,
  deployments: [
    {
      dataCollectionId: <uuid>,
      cachedAt: <iso>,
      queuedRecords: [
        { recordId, attempt, firstQueuedAt, layerId, kind: 'insert'|'update'|'delete' },
        ...
      ]
    }
  ],
  storageEstimate: { usage, quota }
}
```

This is metadata only, not the records themselves. The records
remain in IndexedDB with their full payloads. The mirror gives
the admin a view of "User X's device has 47 records queued,
oldest is from 3 days ago" so they can:

- Email the user a "your data isn't synced yet" reminder.
- Mark the device as stuck and walk the user through a manual
  recovery (see field-offline-recovery.md for the QR / file
  export path).
- Confirm a record is at minimum acknowledged at the server even
  if the body hasn't synced yet, which is information by itself.

The endpoint is rate-limited to one POST per device per minute.
The body is small (a few KB even for thousands of queued records)
because it carries no payloads.

This is **not** a replacement for the actual sync. It's a beacon
that says "this device exists and this is what's on it." The
sync still has to happen via the regular write path so the
records get the same validation, auth, and audit trail as a live
edit.

### Tier 5: user export and QR handoff

Already covered in `docs/field-offline-recovery.md`. Stays as the
last-ditch path. The new tiers above reduce the cases where this
matters but they don't eliminate them: a phone that drops in a
lake before reaching wifi still needs the export-to-file path,
and the admin still needs the import-from-file path on the
desktop side.

## The field catalog

Today the field route is `/items/<deploymentId>/field` and the
user reaches it from the data_collection detail page. There's no
"see all deployments I have access to" surface. Field Maps users
expect this, and it's also where multi-deployment download
management lives.

Add a top-level `/field` route that:

- Lists every `data_collection` item the user can access, plus a
  per-row download status: "Not cached" / "Cached 2 days ago,
  14 MB" / "12 unsynced edits".
- Supports search, sort by recently used, filter by access scope.
- Each row links to `/items/<id>/field` (the runtime).
- Has a per-row "Sync now" affordance when there are queued
  edits, even without entering the runtime.
- Shows the device's total storage usage across all cached
  deployments, with a warning band when usage exceeds 80% of
  quota.

The existing items list still shows data_collection items mixed
with everything else; `/field` is the dedicated lens for field
work, the same way `/admin/housekeeping` is the dedicated lens
for content lifecycle.

The sidebar link between Items / Folders / Groups gets a "Field"
entry alongside, visible to any user who has access to at least
one data_collection item (so it doesn't clutter the nav for org
admins managing pure-data portals).

## Offline areas: pre-generated vs on-demand

### Today (on-demand only)

A user opens a deployment, taps Download, the field client walks
every editable layer, fetches its features (bbox-clipped if the
deployment defines a bbox), pulls bound forms, pulls referenced
pick lists, and writes the lot to IndexedDB. Time-to-ready is
proportional to layer count and feature count; for a typical
small deployment it's under a minute, for a large one with
hundreds of thousands of features it's many minutes and is
unstable on flaky network.

This is the right primitive for "I'm heading somewhere the admin
didn't anticipate." It stays. The problem it doesn't solve:

- Five workers on the same crew each independently re-fetch the
  same feature set. The server does the same work N times. They
  all wait.
- The state they end up with is similar but not identical
  (features that mutated between two workers' downloads diverge).
- Tile caching, when we add it, will be the slow part; per-user
  tile fetches multiply this problem.

### Proposed: admin-defined offline areas

A new `offline_area` concept attached to a data_collection item.
For v1 it lives as a sub-resource on the data_collection's
`data` JSON (no new item type, no new table) so we can iterate on
the shape without a migration. If it earns first-class status we
promote it to its own item type later.

Shape:

```ts
interface OfflineArea {
  id: string;
  name: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | { bbox: [n,n,n,n] };
  tileZoomRange: [number, number]; // e.g. [10, 18]
  refreshSchedule:
    | { kind: 'manual' }
    | { kind: 'on-source-change' }   // rebuild when any source layer is edited
    | { kind: 'cron'; cron: string }; // e.g. nightly
  build: {
    status: 'never-built' | 'queued' | 'building' | 'ready' | 'failed';
    versionId?: string;             // bumps on every successful build
    builtAt?: string;
    sizeBytes?: number;
    error?: string;
  };
  // Reference to the snapshot artifact in MinIO once built.
  // Format: gzipped JSON manifest + per-layer GeoJSON +
  // (later) per-tile blobs in a flat key prefix.
  snapshotKey?: string;
}
```

### Build pipeline

1. Admin opens the data_collection detail page, "Offline areas"
   panel, clicks "Add area." Draws a polygon (reuse the
   geo_boundary editor's draw widget) or picks a stored
   geo_boundary, sets a name and tile zoom range.
2. Save writes the offline_area record into the data_collection's
   data and queues a build job.
3. A new BackgroundQueue / job-runner module (modest scope:
   in-process worker, table-backed queue) picks up the job. Steps:
   1. Walk every editable layer in the deployment, fetch GeoJSON
      clipped to the area polygon.
   2. Fetch bound form schemas and referenced pick lists.
   3. Render vector tiles via pg_tileserv at the configured zoom
      range, write them to MinIO under a per-area prefix.
   4. Compute a manifest: layer hashes, form hashes, pick-list
      hashes, tile count, total bytes, schema version.
   5. Bump versionId. Write build record back to the
      data_collection.
4. The build job fires a notification to the deployment owner
   (via the Notifications module that already exists).

### Client-side download

The field client lists pre-built areas alongside the on-demand
"draw your own" option. Per area:

- Area name, last built timestamp, size.
- "Download" button. The download streams the snapshot manifest
  in one HTTP call, unzips into IndexedDB. Time-to-ready for a
  large deployment drops from minutes to tens of seconds, with
  network hits that are server-cacheable.

The deployment manifest record gains a `builtFromAreaId` and
`builtVersionId` so the client knows what snapshot it loaded.

### Refresh detection

The field catalog calls `GET /api/portal/items/<dcId>` on focus
and compares each cached deployment's `builtVersionId` to the
server's current versionId for that area. If they differ:

- The catalog shows "Refresh available, {{newSize}} new" on the
  row, with a Refresh button.
- The runtime shows the same chip in the header.

Refresh **never silently overwrites**. It always preserves any
queued edits. If queued edits target features that the new
snapshot has changed server-side, the post-refresh sync surfaces
those as version conflicts the user resolves explicitly. (See
field-offline-recovery.md for the conflict resolution model.)

### Hybrid: on-demand still works

A user can always tap "Download a custom area" from the catalog,
draw a polygon, and run the live download. The result is stored
in IndexedDB the same way; the only difference is that no
snapshot key is recorded, so refresh detection doesn't apply. If
the user later decides "I want this to become a managed area,"
the admin can ingest the polygon as a new offline_area definition
and queue a build.

## Storage management UX

A new "Storage" panel, accessible from both the field catalog and
the field runtime header. Shows:

- Total used / total quota (`navigator.storage.estimate()`),
  with a progress bar that turns amber at 80% and red at 95%.
- Per-deployment breakdown: name, size, cached at, queued edits.
- Per-deployment "Free up space" action that drops the cached
  features and forms but never the queued edits. (Queued edits
  are sacred; they only leave by syncing or by an explicit
  "delete unsynced" double-confirm.)
- Persistent-storage badge: "Persistent" green or "Best effort"
  amber with a "Make persistent" button.
- PWA install banner when not installed.

When a download would exceed available quota, we block the
download with an explicit "Free up X MB to download this area"
dialog rather than letting the browser silently fail mid-stream.

## Versioning, conflicts, and refresh semantics

Already covered piecemeal across the recovery doc, but worth
restating since pre-generation makes this more visible:

- **Snapshot version != source-of-truth version.** When a snapshot
  was built at time T, server-side data may have moved on by the
  time a worker downloads it at time T+24h. That's expected. The
  worker is editing against the snapshot's view; conflicts get
  resolved at sync time, same as on-demand downloads.
- **A queued edit always wins on its own version.** If a row was
  edited on the server between download and sync, the client's
  edit either applies cleanly (if the server hasn't seen another
  change to that row) or surfaces as a conflict for the user to
  resolve. We never silently drop the client's change.
- **Refresh of a snapshot does not auto-merge.** The client gets
  the new snapshot but its queue stays intact. Sync runs
  independently and produces conflicts the same way it would have
  without the refresh.
- **Soft delete of an offline_area on the server doesn't yank the
  client's cache.** It marks the area as deprecated. Cached
  copies remain readable; the catalog flags them as "no longer
  available, finish syncing your edits."

## Implementation slices

Slot into the existing Field Maps arc:

**Slice 5 (already queued, #199): queue + sync + per-edit
isolation + admin recovery.** Lands the queue durability and
two-way sync, plus the basic admin "what's queued where" view
that backs Tier 4 above. Includes the queue manifest mirror
endpoint.

**Slice 6 (new): persistence floor.** Add
`navigator.storage.persist()` request, surface persistence badge,
add storage-estimate display, add the storage-quota guard before
download. Small UI lift, big resilience win. Independent of the
catalog work so it can ship first.

**Slice 7 (new): field catalog page.** New `/field` route, multi-
deployment switching, per-deployment status, sidebar entry.

**Slice 8 (new): offline_area schema + admin UI.** Define the
shape on data_collection items, add the "Offline areas" panel on
the detail page, draw + zoom-range editor.

**Slice 9 (new): build pipeline.** In-process job runner, the
build job itself, snapshot artifact format in MinIO. v1 ships
without tile rendering (snapshot is feature data only); tiles
land in Slice 10.

**Slice 10 (new): tile pre-caching + service worker + PWA
install.** The biggest UX boost. Service worker handles tile
fetches against the cached snapshot; manifest enables Add to Home
Screen on iOS, "Install" prompt on desktop and Android Chrome.

**Slice 11 (new): pre-built download in the field catalog.**
Wire the catalog's per-area download to the snapshot artifact,
add refresh detection, plumb the version mismatch UI.

These can land independently. Slice 6 (persistence floor) should
land before any production user has cached anything material;
it's pure upside and pure protection. Slices 8–11 are the
admin-defined-area arc and stack in order.

## Open questions

- **Tile zoom range default.** AGO defaults to a sensible mid-range
  for the area's bbox. We should pick something analogous (e.g.
  derive from the area's geographic size: a 10 km area defaults
  to z14–z18, a 100 km area to z10–z14). Worth empirical testing
  on a few real deployments.
- **Snapshot artifact format.** Single zip vs. directory of
  per-resource files. Single zip is easier on the client (one
  fetch, one parse) and easier on MinIO (one object to track).
  Directory is more partial-update friendly. v1: single zip.
- **Server-side build cost.** A large data_collection with many
  layers and a wide tile range could be a multi-minute job. We
  need a queue with backoff and visibility, not just a fire-and-
  forget setTimeout. See Slice 9 for the in-process runner.
- **Snapshot retention.** When a new build supersedes an old one,
  do we delete the old snapshot immediately or keep it for N
  hours so in-flight downloads can finish? Probably keep for one
  day, then GC.
- **PWA service-worker lifecycle.** A service worker that caches
  tiles needs careful invalidation when basemaps change. We
  shouldn't tile-cache so aggressively that admin basemap edits
  take a week to propagate.

## What we are explicitly NOT doing

- **Background sync.** The field client doesn't try to sync while
  the user isn't on the field page. Sync runs when the runtime is
  open and online. Background sync via service worker is
  attractive but multiplies failure modes (silent failures,
  permission loss, OS-killed workers); v1 prefers visible sync.
- **Server-side per-record encryption at rest.** PostGIS does
  encryption at rest the way the underlying storage configures
  it; we don't add per-record key management here.
- **Cross-device queue migration.** A worker who picks up a
  different device starts from the catalog and re-downloads. The
  queue lives with the device, not with the user account. (This
  is a design choice in line with Field Maps and avoids the "I
  signed in on my phone and accidentally moved the queue off my
  tablet" failure mode.)
