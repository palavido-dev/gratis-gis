---
id: analysis-fishnet
title: Fishnet
summary: Generate a regular square grid over a polygon source (filled cells or grid lines). The starting layer for many "binned-by-cell" workflows.
category: analysis
order: 90
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - fishnet
  - grid
related:
  - items-derived-layer
  - analysis-spatial-join
  - analysis-group-by
---

A **fishnet** step builds a regular **square** grid over the
bounding box of a polygon source, then keeps (and clips) only
cells that intersect the source geometry. Pair it with a
spatial join and group-by for heatmap-style "count per cell"
summaries.

Hex cells, a separate geo-boundary / manual extent picker, and
a separate "clip polygon" control are **not** options on this
path. The extent and clip come from the pipeline source itself.

## Inputs

- **Source layer** of polygon (or multipolygon) features. The
  grid covers each feature's bounding box and is clipped with
  `ST_Intersection` to that feature.
- **Cell size**: edge length in meters, feet, or miles (converted
  to degrees for PostGIS `ST_SquareGrid` on EPSG:4326 storage).
- **Output mode**:
  - **Polygons**: one polygon row per intersecting cell
    (partial cells are clipped to the source edge).
  - **Lines**: grid-line edges clipped to the source (transect /
    sampling-line style).

## Output

One row per grid cell (or line segment set) that intersects the
source. Source attributes are dropped. Schema:

- `cell_row`, `cell_col`: integer grid indices from
  `ST_SquareGrid`.

There is no `area_m2` or `bbox` property on this path.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a polygon Source (city boundary, study area, etc.).
3. Add a **Fishnet** step.
4. Set cell size, unit, and polygons vs lines.
5. Save.

Expect a short server job. Very small cell sizes on large
extents are refused at save time (safety cap about one million
cells).

## Example: incident density by 500 m cell

1. Fishnet over a city boundary polygon, square cells, 500 m
   edge, output polygons.
2. Spatial join: target = fishnet, join = incidents,
   predicate = contains (or intersects), as appropriate.
3. Group by: keys = `cell_row`, `cell_col`. Aggregate =
   `count(*)` as incident count. Geometry strategy = `first`
   (keep the cell polygon).
4. Symbology: graduated on the count.

## Notes

- **Square only.** Hexagonal fishnets are not shipped.
- **Cell counts grow fast.** A fine grid over a county-scale
  polygon can hit the save-time safety cap; increase cell size
  or use a smaller source.
- **Cells outside the source drop.** Partial cells at the edge
  are clipped; cells that only touch at a point can become empty
  and disappear from useful results.
- **Meter sizes are approximate in geographic CRS.** The portal
  converts cell size with a constant meters-per-degree factor on
  EPSG:4326. At high latitudes cells are not perfectly square on
  the ground; city-to-state workflows are the intended scale.
- **Point or line sources** are a poor fit; the SQL intersects
  against the source geometry and can yield empty results.
