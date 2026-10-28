---
id: analysis-vertices
title: Vertices
summary: Explode each geometry into one point per vertex via PostGIS ST_DumpPoints. Adds vertex_index; row count can grow a lot.
category: analysis
order: 67
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - vertices
related:
  - items-derived-layer
  - analysis-densify
  - analysis-simplify
  - analysis-convex-hull
---

A **vertices** step explodes each input geometry into one point
feature per vertex (`ST_DumpPoints`). Source attributes pass
through, and each output row gains a numeric `vertex_index`
(0-based within that input feature).

Use for "show me the corners," densify prep, or point-density
views of traced lines. Pair with [Densify](analysis-densify) when
you need more vertices first, or [Simplify](analysis-simplify)
when you need fewer.

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped. The step has no parameters in the derived-layer
  builder.

## Output

- Geometry: point at each vertex (WGS84).
- Properties: source attributes plus `vertex_index`.
- **Row count grows.** One polygon with hundreds of corners
  becomes hundreds of point rows. Dense layers can hit the
  recipe `featureLimit` quickly.
- **MULTI* and collections** dump vertices from every part into
  one flat sequence per input feature (indices reset per source
  row).

Identity stays on the source `global_id`; disambiguate vertices
with `(global_id, vertex_index)`.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Vertices for this layer**.
3. Optionally edit the title.
4. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. Dense sources
may take longer and produce many rows.

### From the new-item wizard
![Derived layer recipe with a Vertices step](/help/analysis/vertices-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Vertices** step.
4. Save.

## Examples

- **Parcel corners**. Source: parcel polygons. Output: one point
  per ring vertex with `vertex_index`.
- **Road nodes for sampling**. Source: centerlines (optionally
  densified first). Output: points along each line.

## Notes

- **No sample-every-Nth control** in v1. To thin vertices, run
  Simplify (or Densify with a larger max segment) before this
  step.
- **Not a topology node layer.** Shared edges between adjacent
  polygons produce duplicate corner points; there is no dissolve
  of coincident vertices.
