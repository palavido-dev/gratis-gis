---
id: items-derived-layer
title: Derived layer
seoTitle: "Derived layers: live GIS analysis computed in PostGIS"
summary: An item that stores an analysis recipe and computes features on every read from a source data layer (or another derived layer) via PostGIS.
category: items/data
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
![New Derived layer item type in the wizard](/help/analysis/derived-layer-new-item.png)

A **derived layer** is an item whose features are computed from
other layers by a pipeline of analysis steps. The item stores the
**recipe** (source + ordered steps), not a warehouse table of
output rows. On every map or API read, the portal composes
PostGIS SQL from that recipe and returns the current result.

You can put a derived layer on a map, style it, query it, or feed
it into another derived layer. Because it re-runs on read, edits
to the source show up on the next request without a separate
refresh button.

For one-step recipes, a data layer's **Analyze** tab has guided
actions that create a private derived-layer item via PostGIS on
the server: **Buffer**, **Clip**, **Erase**, **Centroids**,
**Convex hulls**, **Bounding boxes**, **Dissolve**,
**Simplify**, **Densify**, **Vertices**, **Calculate
geometry**, **Nearest neighbor**, **Fishnet** (polygon layers),
**Contour** (point layers, auto interval), **Group by** (one key,
count/sum/avg), **Top N**, and **Random sample**. Filter, Spatial
filter, Spatial join, and Calculate field are in the builder and
registry below, not as Analyze shortcuts. Title-only shortcuts
(Centroids, Convex hulls, Bounding boxes, Dissolve, Vertices)
share one form shell driven by tool metadata; tools with extra
parameters keep their own panels. Meter distances and tolerances
stay honest; the in-browser SQL builder does not invent
degree-unit geometry ops.

The Analyze tab also shows a **Past runs** shelf of your
derived layers whose source is this data layer. **Re-run** posts
a new private item with the same recipe; **Edit & re-run** opens
the matching guided form (`?tool=` deep link) when that tool has
an Analyze shortcut. This is not a job ledger or recipe DAG.
See [Buffer](/help/analysis/buffer), [Bounding box](/help/analysis/bbox),
[Vertices](/help/analysis/vertices), [Calculate](/help/analysis/calculate),
[Simplify](/help/analysis/simplify), [Densify](/help/analysis/densify),
[Nearest neighbor](/help/analysis/nearest-neighbor),
[Fishnet](/help/analysis/fishnet), [Contour](/help/analysis/contour),
[Group by](/help/analysis/group-by), [Top N](/help/analysis/top-n), and
[Random sample](/help/analysis/random-sample).

## Pipeline model

A derived layer is an ordered list of **steps**, each producing a
new intermediate result from its inputs. Available steps (same
set as the derived-layer builder / tool registry):

### Attribute and sampling

- **[Filter](/help/analysis/filter)**. Keep rows matching a `{{field}}`
  expression.
- **[Calculate field](/help/analysis/calculate)** /
  **[Calculate geometry](/help/analysis/calculate)**. Add a computed
  attribute column, or length / perimeter / area from geometry.
- **[Group by](/help/analysis/group-by)**. Roll up rows with aggregates;
  geometry is always `ST_Union` per group.
- **[Top N](/help/analysis/top-n)**. Keep the N highest or lowest
  numeric values.
- **[Random sample](/help/analysis/random-sample)**. Deterministic
  percentage or count sample with a stable seed.
- **[Nearest neighbor](/help/analysis/nearest-neighbor)**. Add
  `nearest_distance_m` to the closest other feature in the same
  layer.

### Geometry transform

- **[Buffer](/help/analysis/buffer)**. Expand each geometry by a
  meter-honest distance.
- **[Simplify](/help/analysis/simplify)**. Drop vertices within a
  tolerance (`ST_Simplify`).
- **[Densify](/help/analysis/densify)**. Add vertices so no segment
  exceeds a max length (`ST_Segmentize` on geography).
- **[Centroid](/help/analysis/centroid)**. Replace each geometry with
  its centroid.
- **[Convex hull](/help/analysis/convex-hull)**. Per-feature convex
  hull (`ST_ConvexHull`).
- **[Bounding box](/help/analysis/bbox)**. Replace each geometry with
  its envelope (`ST_Envelope`).
- **[Vertices](/help/analysis/vertices)**. Explode geometries to point
  vertices (`ST_DumpPoints` + `vertex_index`).
- **[Dissolve](/help/analysis/dissolve)**. Union every input into one
  feature (attributes dropped; keyed dissolve stays on group-by).

### Overlay and generate

- **[Spatial join](/help/analysis/spatial-join)**. Attach a count or
  selected attributes from another data layer (within /
  intersects / nearest).
- **[Spatial filter](/help/analysis/spatial-filter)**. Keep rows by
  spatial predicate against another source (no attribute join).
- **[Clip](/help/analysis/clip)**. Trim features to a mask polygon.
- **[Erase](/help/analysis/erase)**. Subtract a mask from features.
- **[Fishnet](/help/analysis/fishnet)**. Square grid over an extent.
- **[Contour](/help/analysis/contour)**. Iso-lines from a numeric
  column (TIN path).

Steps feed forward in order. The last step's output is the
derived layer's features for that read.

## Inputs

The recipe's **source** is either:

- A **data layer** in this org (or shared with you), or
- Another **derived layer** (chained recipes).

Overlay steps (clip, erase, spatial join, spatial filter) may
also reference a second **data layer** as `otherSource`. There is
no ArcGIS-service streaming input on the derived-layer recipe
today; use a local data layer (or pull data into one) first.

The pipeline runs server-side in PostGIS. The upstream layer does
not have to be open in a browser for the derived layer to compute.

## How reads work

A derived layer is **computed on read**: the detail page and the
map/API read path compose SQL from the saved recipe and run it
against current source rows. There is no separate materialized
output table, no **Refresh** button on the item detail page, and
no scheduled-refresh option.

The detail page shows the source, pipeline, cached output schema
(column list recorded at save), and the recipe's **feature
limit**.

What this means in practice:

- **Always current with the source** (within the feature limit and
  any map bbox you pass).
- **Cost is on every read**, not once at save. Heavy steps (for
  example nearest-neighbor over a large layer) can be slower than
  a plain data-layer query.
- **Not a warehouse snapshot.** If you need a frozen copy of the
  rows at a point in time, export or copy into a data layer; the
  derived item itself keeps re-running the recipe.

## Cost and limits

Each recipe has a **feature limit** (default **1,000**, hard
ceiling **50,000** features per read). Map views usually also pass
a bbox, so the limit is mainly a safety net for unbounded
requests. There is no 5-million-row save acknowledgement UI; the
feature limit is the guardrail.

Some tools add their own save-time checks (for example fishnet
cell-count budgets). Those still do not create a separate
materialized table.

## Sharing

Standard three-tier sharing applies to the derived-layer item.
Reading features runs the live pipeline against the source (and
any `otherSource` layers). Callers need read access on those
inputs as well; this is not a detached snapshot table that can be
shared without upstream rights.

## See also

- **[Buffer](/help/analysis/buffer)**. The simplest one-step recipe
  with a distance.
- **[Spatial join](/help/analysis/spatial-join)** /
  **[Spatial filter](/help/analysis/spatial-filter)**. Decorate vs
  keep/drop by location.
- **[Group by](/help/analysis/group-by)**. Aggregates with unioned
  geometry.
- **[Workflows](/help/analysis/workflows)**. Multi-step patterns.
