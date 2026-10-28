---
id: items-derived-layer
title: Derived layer
summary: An item that produces features by running a pipeline of analysis steps against one or more source layers. The output is queryable like a data layer.
category: items
order: 140
complexity: intermediate
tags:
  - derived-layer
  - item-type
  - analysis
related:
  - items-data-layer
  - analysis-buffer
  - analysis-simplify
  - analysis-spatial-join
  - analysis-filter
---

A **derived layer** is an item whose features are computed from
other layers by a pipeline of analysis steps. The output rows are
materialized into a PostGIS table and behave like any other layer:
you can put them on a map, style them, query them, or feed them
into another derived layer.

For one-step recipes, a data layer's **Analyze** tab has guided
actions that create a private derived-layer item via PostGIS on
the server: **Buffer**, **Clip**, **Erase**, **Centroids**,
**Convex hulls**, **Bounding boxes**, **Dissolve**,
**Simplify**, **Densify**, **Vertices**, **Calculate
geometry**, **Nearest neighbor**, **Fishnet** (polygon layers),
**Contour** (point layers, auto interval), **Group by** (one key,
count/sum/avg), **Top N**, and **Random sample**. Meter distances
and tolerances stay honest; the in-browser SQL builder does not
invent degree-unit geometry ops.
See [Buffer](analysis-buffer), [Bounding box](analysis-bbox),
[Vertices](analysis-vertices), [Calculate](analysis-calculate),
[Simplify](analysis-simplify), [Densify](analysis-densify),
[Nearest neighbor](analysis-nearest-neighbor),
[Fishnet](analysis-fishnet), [Contour](analysis-contour),
[Group by](analysis-group-by), [Top N](analysis-top-n), and
[Random sample](analysis-random-sample).

## Pipeline model

A derived layer is an ordered list of **steps**, each producing a
new intermediate result from its inputs. Available steps (same
set as the derived-layer builder / tool registry):

### Attribute and sampling

- **[Filter](analysis-filter)**. Keep rows matching a `{{field}}`
  expression.
- **[Calculate field](analysis-calculate)** /
  **[Calculate geometry](analysis-calculate)**. Add a computed
  attribute column, or length / perimeter / area from geometry.
- **[Group by](analysis-group-by)**. Roll up rows with aggregates;
  geometry is always `ST_Union` per group.
- **[Top N](analysis-top-n)**. Keep the N highest or lowest
  numeric values.
- **[Random sample](analysis-random-sample)**. Deterministic
  percentage or count sample with a stable seed.
- **[Nearest neighbor](analysis-nearest-neighbor)**. Add
  `nearest_distance_m` to the closest other feature in the same
  layer.

### Geometry transform

- **[Buffer](analysis-buffer)**. Expand each geometry by a
  meter-honest distance.
- **[Simplify](analysis-simplify)**. Drop vertices within a
  tolerance (`ST_Simplify`).
- **[Densify](analysis-densify)**. Add vertices so no segment
  exceeds a max length (`ST_Segmentize` on geography).
- **[Centroid](analysis-centroid)**. Replace each geometry with
  its centroid.
- **[Convex hull](analysis-convex-hull)**. Per-feature convex
  hull (`ST_ConvexHull`).
- **[Bounding box](analysis-bbox)**. Replace each geometry with
  its envelope (`ST_Envelope`).
- **[Vertices](analysis-vertices)**. Explode geometries to point
  vertices (`ST_DumpPoints` + `vertex_index`).
- **[Dissolve](analysis-dissolve)**. Union every input into one
  feature (attributes dropped; keyed dissolve stays on group-by).

### Overlay and generate

- **[Spatial join](analysis-spatial-join)**. Attach a count or
  selected attributes from another data layer (within /
  intersects / nearest).
- **[Spatial filter](analysis-spatial-filter)**. Keep rows by
  spatial predicate against another source (no attribute join).
- **[Clip](analysis-clip)**. Trim features to a mask polygon.
- **[Erase](analysis-erase)**. Subtract a mask from features.
- **[Fishnet](analysis-fishnet)**. Square grid over an extent.
- **[Contour](analysis-contour)**. Iso-lines from a numeric
  column (TIN path).

Steps feed forward in order. The last step's output is the
derived layer's features.

## Inputs

Each step takes one or more **layer references** as input. A layer
reference is any of:

- A **data layer** sublayer (this org's, or another org's shared
 to you).
- Another **derived layer's** output.
- An **ArcGIS service** sublayer (streaming).

The pipeline runs server-side; the upstream layer doesn't have to
be loaded in a browser for the derived layer to compute.

## Materialization

A derived layer is **materialized**: when you save it, the portal
runs the pipeline and stores the result rows in a real PostGIS
table. Downstream queries hit the table directly, not the
pipeline.

This means:

- **Fast at query time.** No per-request recomputation.
- **Stale when inputs change.** The pipeline doesn't re-run
 automatically on input edits. The detail page surfaces a
 **Refresh** button to recompute.

A scheduled-refresh option (every N minutes, hourly, nightly) is
available for derived layers whose inputs change predictably.

## Cost and limits

Each step has a documented cost profile. The detail page shows
the last run's wall time and row count. Pipelines whose final
output exceeds **5M rows** require an explicit acknowledgement
to save; very large outputs can saturate the org's storage budget
quickly.

## Sharing

Standard three-tier. A user who can read the derived layer but
not its inputs still sees the materialized output rows (because
those live in this item's table). This is the right call for most
cases; if you need to lock derived output to upstream readers,
share at the same tier as the most-restrictive input.

## See also

- **[Buffer](analysis-buffer)**. The simplest one-step recipe
  with a distance.
- **[Spatial join](analysis-spatial-join)** /
  **[Spatial filter](analysis-spatial-filter)**. Decorate vs
  keep/drop by location.
- **[Group by](analysis-group-by)**. Aggregates with unioned
  geometry.
- **[Workflows](analysis-workflows)**. Multi-step patterns.
