---
id: items-geo-boundary
title: Geo boundary
summary: A reusable polygon (or multipolygon) referenced by share geo limits, map viewports, and dashboard filters.
category: items/data
order: 100
complexity: intermediate
tags:
  - geo-boundary
  - item-type
  - schema
  - sharing
related:
  - items-data-layer
  - items-pick-list
  - sharing-an-item
---

A **geo boundary** is an item whose body is a single polygon (or
multipolygon) plus a name. Use it anywhere a system feature needs
"the same shape, referenced from multiple places": the county
boundary you scope sharing to, the floodplain a dashboard filters
to, the project area a map opens to.

## Why geo boundaries are their own item

Like pick lists, the same shape often appears in many configs. A
boundary item lets you reference it by id and edit the geometry
once when (for example) the city annexes a new neighborhood and
the official boundary shifts.

## Where they're referenced

- **Share geo limits**. A per-share polygon clip on a layer. The
 user can read the layer, but only sees features inside the geo
 boundary.
- **Map viewport defaults**. Open the map zoomed to this boundary.
- **Dashboard filters**. Constrain dashboard widgets to features
 inside the boundary.
- **Derived layer steps**. Clip-by-geo-boundary, fishnet over a
 geo-boundary extent, group-by polygons-in-this-boundary.

## What's stored

- **Geometry**. A polygon or multipolygon in EPSG:4326.
- **Name and description**.
- **Computed metadata**: area in m^2 / mi^2 / ha, bounding box,
 centroid.

## Creating one

Three ways:

1. **Import** from a single-feature GeoJSON or Shapefile via the
 new-item wizard.
2. **Draw** directly in the portal with a polygon-draw tool.
3. **Copy from a feature**. The "Save geometry as boundary"
 action on a layer's feature row converts that feature's
 polygon into a new geo-boundary item.

## Editing

The detail page has an edit-geometry tool. Edits are tracked in
the engine's observation log; downstream references see the new
shape on the next save. Anything pre-computed against the old
shape (a share geo limit's effective row set, a clipped derived
layer) updates lazily on the next read.

## Notes

- **Lines and points** aren't geo boundaries; this item type is
 specifically for polygons used as scopes/clips.
- **Multipart polygons** are fine. A county that includes islands
 stays as one geo boundary.
