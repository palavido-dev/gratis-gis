# maplibre-gl-lidar: incremental per-node append (2026-10-27)

Research note for [GratisGIS #183](https://github.com/palavido-dev/gratis-gis/issues/183).
This documents the rebuild jank that size-aware streaming tiers only
mitigate, and proposes the upstream shape that would actually fix it.
It does **not** close #183, and it does **not** pick the Tile3D /
heavy-cloud strategy (that stays `needs-maintainer` as Q-183b).

Checked against [opengeos/maplibre-gl-lidar](https://github.com/opengeos/maplibre-gl-lidar)
`v0.21.0` source (`PointCloudManager.ts`, `CopcStreamingLoader.ts`,
`LidarControl.ts`) and against GratisGIS's pinned `0.16.2` + local
MapLibre overlay patch. The rebuild path described below is unchanged
between those versions.

## Symptom

On a ~209M-point COPC (WV 3DEP merge), pan/zoom hangs: a `requestAnimationFrame`
long-frame monitor showed main-thread stalls up to ~1.9s whenever a
batch of streamed octree nodes landed. Steady-state fps between stalls
was fine (~50). That is batch-rebuild jank, not fill-rate cost.

## Why the library rebuilds the world

`CopcStreamingLoader` already thinks in octree nodes. It keeps a node
cache, respects a point budget, and loads center-first. Decoded LAZ
lands in workers. The bottleneck is what happens after that.

Every stream update ends in
`PointCloudManager.updatePointCloud(id, data)`. That method:

1. Re-runs the color processor over the **full** in-memory cloud.
2. Calls `_createLayer(id)`, which **removes every existing deck.gl
   chunk layer** for that cloud id.
3. Walks all `data.pointCount` points to build a filtered index list
   (elevation range).
4. Copies positions and colors into fresh `Float32Array` /
   `Uint8Array` chunks of 1M points each.
5. Constructs new `PointCloudLayer` instances and adds them to the
   overlay.

So cost scales with the resident point budget on every batch, not with
the delta that just arrived. Camera movement triggers repeated
rebuilds (library default viewport debounce 150ms). When picking is
on, deck.gl also keeps picking buffers over the whole set.

"Chunks" here are WebGL buffer-size shards of one merged dataset.
They are **not** octree nodes. Evicting a COPC node still forces a
full re-merge of whatever remains in the budgeted buffers.

## What GratisGIS already shipped (mitigations only)

Shared helpers in portal-web (item viewer and map overlay):

| tier | when | budget | viewport debounce | concurrent | picking default |
| --- | --- | --- | --- | --- | --- |
| default | ≤20M points | 4M | 150ms | 4 | on |
| huge | >20M | 1.5M | 400ms | 4 | off |
| ultra | >100M | 750k | 600ms | 2 | off |

Plus `deferLidarUpdatesWhileMoving`: wraps
`LidarControl._pointCloudManager.updatePointCloud` so stream batches
coalesce until MapLibre `moveend` / `zoomend`. Streaming I/O continues;
interactive pan no longer pays a full rebuild per batch.

These are honest knobs. They trade density and update cadence for
responsiveness inside the current renderer. They are not the fix.
[#183](https://github.com/palavido-dev/gratis-gis/issues/183) stays open.

## Proposed upstream: append / evict per octree node

Mature viewers (Potree, Cesium, deck.gl `Tile3DLayer` traversal) never
rebuild the world per update. Each octree node becomes its own GPU
resource; traversal adds and removes nodes individually; screen-space
error decides which nodes are resident.

Suggested library shape for maplibre-gl-lidar:

1. **Per-node layer identity.** Give each loaded COPC/EPT node a stable
   deck.gl layer id (for example `pointcloud-${cloudId}-node-${nodeKey}`)
   instead of one set of million-point chunks for the whole cloud.
2. **`appendNodes` / `evictNodes` on the manager.** On a stream batch,
   create layers only for newly loaded nodes and remove layers only for
   evicted keys. Do not recolor or re-copy untouched nodes.
3. **Keep the budgeted CPU buffers optional.** Loaders can still cap
   resident points; the renderer should not need a contiguous merged
   `PointCloudData` to paint.
4. **SSE LOD as a follow-on.** Budget alone picks how many points; SSE
   picks the right depth per view (coarse when zoomed out, deep only in
   the close frustum). COPC's octree already carries the hierarchy.
   Treat SSE as part of whichever renderer wins long-term.
5. **Picking.** Prefer per-node picking or a deferred picking pass so
   enabling inspect does not force a full-cloud picking buffer rebuild
   on every append.

deck.gl already supports the layer-per-node pattern (many
`PointCloudLayer`s, or `Tile3DLayer`'s managed traversal). The change
is mostly in `PointCloudManager` + how `CopcStreamingLoader` /
`EptStreamingLoader` notify it.

### Acceptance sketch for an upstream PR

- Stream-updating a cloud whose resident set is N points while adding
  a node of size D does work proportional to D (plus overlay bookkeeping),
  not to N.
- Evicting a node removes one layer id without recreating siblings.
- Existing single-shot LAS/LAZ load path can keep `_createLayer`-style
  behavior.
- A before/after long-frame capture on a >100M COPC during pan shows
  stalls dropping from multi-hundred-ms rebuilds toward ordinary frame
  time when only a few nodes change.

## Upstream filing status

As of 2026-10-27 there is **no** open issue on
[opengeos/maplibre-gl-lidar](https://github.com/opengeos/maplibre-gl-lidar/issues)
that requests incremental per-node append/evict. Related open issues
cover teardown, WebGL context release, and CSP / wasm loading, not this
rebuild path.

Autonomy agents on this repo could not open an upstream issue from the
available GitHub token (no `createIssue` scope on that org). Maintainers
(or a token with rights) should file against opengeos/maplibre-gl-lidar
using this note, then link the upstream URL from #183.

Suggested upstream title:

> Streaming COPC/EPT: append/evict per-node PointCloudLayers instead of
> full dataset rebuild in PointCloudManager.updatePointCloud

## What this note deliberately leaves alone

- **COPC → 3D Tiles + `Tile3DLayer` (strategy phase B).** Still the
  strongest path for meshes, terrain, and ultra-heavy clouds on one
  renderer. Queued as Q-183b / `needs-maintainer`. Do not claim #183
  done by choosing it here.
- **Bumping GratisGIS past maplibre-gl-lidar 0.16.2.** Upstream is at
  0.21.0; we still carry a MapboxOverlay → MapLibreOverlay patch. A
  version bump is separate dependency work and does not remove the
  rebuild architecture.
- **Closing #183.** Leave it open until upstream per-node append (or an
  explicit Tile3D heavy-cloud path) lands in product.

## Links

- Issue: https://github.com/palavido-dev/gratis-gis/issues/183
- Library: https://github.com/opengeos/maplibre-gl-lidar
- Manager (rebuild): `src/lib/layers/PointCloudManager.ts` (`updatePointCloud`, `_createLayer`)
- Streaming loader: `src/lib/loaders/CopcStreamingLoader.ts`
- Local mitigations: `apps/portal-web/src/lib/point-cloud-streaming.ts`,
  `apps/portal-web/src/lib/defer-lidar-updates.ts`
- Local patch: `patches/maplibre-gl-lidar@0.16.2.patch`
