---
id: items-point-cloud
title: Point cloud
summary: A 3D lidar COPC item. Viewers stream octree nodes in view with size-aware density tiers; not Potree or Tile3D yet.
category: items/data
order: 125
complexity: intermediate
tags:
  - point-cloud
  - item-type
  - lidar
  - copc
related:
  - reference-item-types
  - items-tile-layer
  - items-map
---

A **point cloud** item stores a Cloud Optimized Point Cloud (COPC)
file in portal object storage. The item page and map overlays use
`maplibre-gl-lidar` to stream octree nodes for the current viewport
over HTTP range requests.

That is **not** full Potree-style continuous LOD, Cesium 3D Tiles,
or server-side SSE octree rebuild. For very large clouds the portal
applies **local density and responsiveness tradeoffs** so the tab
stays usable while #183 (heavy-cloud path) stays open.

## Upload

- Accepts COPC (`.copc.laz` / finalized COPC). Plain LAS/LAZ may
  need conversion before finalize succeeds — the item panel
  surfaces that hint.
- Multi-tile merge builds one COPC from uploaded sources; long
  merges show a rough ETA.

## Streaming in the viewer

Viewers request only nodes that intersect the camera frustum.
Each stream batch still rebuilds the in-memory deck.gl dataset on
the main thread, so cost scales with the **in-view point budget**,
not only with network bytes.

### Size-aware tiers

The portal picks a tier from the item's reported point count:

| Tier | When | What changes |
| --- | --- | --- |
| **default** | ≤ 20M points | ~4M in-view budget, short debounce, picking on |
| **huge** | > 20M | ~1.5M budget, longer debounce, picking starts off |
| **ultra** | > 100M | ~0.75M budget, longer debounce, fewer concurrent fetches, picking off |

On huge and ultra clouds the item viewer also shows a muted note
and defers deck.gl rebuilds while you pan or zoom (streaming I/O
keeps running; the expensive flush waits until the camera settles).

These knobs are **mitigations**, not a finished LOD system. They
do not convert COPC to 3D Tiles, do not claim Tile3DLayer, and do
not close the heavy-cloud work tracked in #183.

## Maps

Point-cloud layers on a map use the same tier table. Overlays keep
picking off for UX reasons regardless of tier.

## What this is not

- **Not Potree.** No progressive multi-resolution mesh that stays
  smooth at continental density without budget cuts.
- **Not Tile3D / Cesium yet.** COPC → 3D Tiles remains a
  needs-maintainer strategy item.
- **Not unlimited in-memory points.** Crossing the tier thresholds
  deliberately shows fewer points so pan/zoom does not hang the tab.

## See also

- Research write-up on incremental append vs full rebuild (in-repo
  `docs/research/maplibre-gl-lidar-incremental-append-2026-10-27.md`).
