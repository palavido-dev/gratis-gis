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
actions (**Buffer**, **Clip**, **Erase**, **Centroids**,
**Convex hulls**, **Dissolve**, **Simplify this layer**, …) that create a private
derived-layer item via PostGIS on the server. Meter distances and
tolerances stay honest; the in-browser SQL builder does not invent
degree-unit geometry ops. See [Buffer](/help/analysis/buffer) and
[Simplify](/help/analysis/simplify).

## Pipeline model

A derived layer is an ordered list of **steps**, each producing a
new intermediate result from its inputs. Available steps:

- **Filter**. Keep rows matching an expression.
- **Calculate**. Add a computed column.
- **Buffer**. Expand each input by a fixed distance.
- **Spatial join**. Attach attributes from one layer to features
 of another based on spatial relationship.
- **Group by**. Roll up rows into groups with aggregates.
- **Dissolve**. Union every input geometry into one feature
  (attributes dropped; keyed dissolve stays on group-by).
- **Simplify**. Drop vertices within a tolerance (`ST_Simplify`).
- **Centroid**. Replace each feature's geometry with its centroid.
- **Fishnet**. Generate a regular grid over an extent.
- **Contour**. Generate iso-lines from a value column.
- **Clip**. Trim features to fit inside a polygon.

Steps reference earlier steps' outputs by name. The last step's
output is the derived layer's features.

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

- **Buffer**. The simplest one-step derived layer recipe.
- **Spatial join**. The most common multi-step recipe (filter,
 then join).
- **Group by**. Roll-up rollups.
