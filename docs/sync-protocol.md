# Field sync protocol

How an offline client (the field PWA, the Android app, QGIS or any
other) keeps a copy of a data layer current, and how it sends edits
back without overwriting someone else's. The server side is
`listDelta` in `apps/portal-api/src/data-layer/features.service.ts`
and `listDeltaSince` in `apps/portal-api/src/engine/data-layer.ts`.
The conformance spec is
`apps/portal-api/src/data-layer/delta-paging.pg.spec.ts`.

## The cursor

Every write batch to a layer takes the next value of the layer's
`syncVersion` counter, under the item row lock, and stamps it on every
observation it writes. One batch is one version: a 25,000 row import,
a replace and its delete tombstones, or a Calculate Field run all
share one number. Versions commit in order.

The delta is ordered by the total order `(syncVersion, tx_time, id)`.
A page can end in the middle of a version, so `syncVersion` alone is
not a page cursor. The page cursor is the pair `(since, after)`:

- `since`: a syncVersion. Rows with a greater version come next.
- `after`: the `observationId` of the last row already applied. When
  set, the scan resumes strictly after that row, inside version
  `since`. It must name a row of this layer whose version is `since`,
  or the server answers 400.

The stored cursor between refreshes is only the integer: the
response `syncVersion` of the last page of a completed walk.

## Delta request and response

```
GET /api/items/{id}/layers/{layerKey}/delta?since=N[&after=OBS][&limit=L]
```

`limit` defaults to 1000 and is at most 10000.

```json
{
  "syncVersion": 42,
  "since": 17,
  "changes": [
    {
      "observationId": "...",
      "entity": "...",
      "kind": "create|update|delete|derive|observe",
      "syncVersion": 18,
      "txTime": "2026-11-08T12:00:00.000Z",
      "authorSub": "...",
      "createdBy": "...",
      "createdAt": "2026-11-01T09:00:00.000Z",
      "geometry": {},
      "properties": {}
    }
  ],
  "truncated": true,
  "nextSince": 18,
  "nextAfter": "..."
}
```

- `syncVersion` is the layer head, read before the changes. Store it
  only when a walk ends with `truncated: false`.
- `nextSince` and `nextAfter` are present only when `truncated` is
  true. They are the last row's `syncVersion` and `observationId`.
- `createdBy` and `createdAt` come from the entity's create
  observation (null when the log holds none).

Older servers send neither `nextSince` nor `nextAfter`. A client that
gets `truncated: true` without them may fall back to
`since = last.syncVersion - 1` when that is greater than the current
`since` (rows of the last version are fetched again, which is
harmless), and must stop and do a full pull when the whole page is one
version.

## Walking the delta

```
since = stored cursor; after = none
loop:
  page = GET delta?since&after&limit=10000
  apply page.changes in order
  if not page.truncated:
    store page.syncVersion; done
  since = page.nextSince; after = page.nextAfter
```

Applying a change:

- `delete`: remove the cached row.
- anything else: upsert the row keyed by `entity`, with properties
  `{...change.properties, _global_id: entity, _observation_id:
  observationId, _edited_by: authorSub, _edited_at: txTime,
  _created_by: createdBy, _created_at: createdAt}`. These are the same
  extra properties a full read inlines, and `_observation_id` is the
  conflict token an edit sends back (see below). When `createdBy` is
  null (older server) keep the cached row's `_created_*`.

Applying is idempotent, so seeing a change twice is safe. Missing one
is not, which is why every rule here errs on the side of repeats.

A client that stops a walk early (a page cap, an error) must store a
cursor no later than the last version it applied completely, that is
`nextSince - 1`, never `nextSince`.

## First download

1. Read the head first: `delta?since=0&limit=1`, keep `syncVersion`.
2. Pull the full layer with keyset paging: `geojson?limit=L` then
   `geojson?limit=L&cursor=nextCursor&at=asOf`, pinning `at` to the
   first page's `asOf`, until `nextCursor` is null. Unpaged reads are
   refused when the server sets `GRATIS_FEATURE_QUERY_PAGE=required`.
3. Store the head from step 1 as the cursor.

Reading the head before the snapshot means a write that lands during
the download is delivered again by the next delta. Reading it after
would skip that write for good.

## Scope

Row scope and share geo limits apply per entity, as on every other
read:

- Own rows: an entity is in scope when its create observation is the
  caller's. Every later observation of it is returned, whoever wrote
  it, so a supervisor's edit or delete reaches the worker.
- Geo limit: a non-delete observation inside the clip (or with no
  geometry, as on reads) is returned as is. A delete, or an
  observation outside the clip, is returned as `kind: "delete"` with
  null geometry and properties only when an earlier observation of
  the entity was visible, so a feature moved out of the share's area
  leaves the device. An entity the caller could never see is never
  returned, tombstones included, so its id and creator do not leak.
  A closed clip returns nothing.

## Sending edits back

- Insert: `POST .../features` with a client generated `globalId`. A
  retry of a create that already landed is deduplicated by that id.
- Update and delete: send `baseObservationId`, the cached row's
  `_observation_id`, on both the `checkOnly=true` dry run and the real
  `PATCH` or `DELETE`. When the server head is not that observation it
  answers 409 `feature-conflict` with the current feature, and records
  a sync-conflict artifact. Without a base the server takes last
  writer wins, so always send it when the cache has one.
- Folding: when several queued edits of one feature fold into one,
  the folded row keeps the first row's base.
- A lost response: an update can commit and its response be lost.
  The retry then gets 409 against the client's own write. If the 409
  `current` feature already carries every queued property value
  (ignoring `_` keys) and the queued geometry, the edit landed: treat
  the row as done. The shared rule is `isOwnEditEcho` in
  `packages/shared-types/src/sync-outcome.ts`, exposed to native
  clients as `sync.isOwnEditEcho` in the field engine.
- After a successful update, the response's `_observation_id` is the
  new base for any later queued edit of the same feature.
