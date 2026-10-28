---
id: analysis-convex-hull
title: Convex hull
summary: Replace each feature's geometry with its convex hull via PostGIS ST_ConvexHull. Attributes are kept.
category: analysis
order: 75
complexity: basic
tags:
  - analysis
  - derived-layer
  - convex-hull
related:
  - items-derived-layer
  - analysis-centroid
  - analysis-dissolve
---

A **convex hull** step replaces each feature's geometry with its
smallest enclosing convex shape (`ST_ConvexHull`). Attributes are
kept; row count is unchanged.

This is **per feature**, not one hull for the whole layer. For a
single combined outline of every feature, use
[Dissolve](analysis-dissolve) (attributes dropped) or
[Group by](analysis-group-by) with empty keys when you also need
aggregates.

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped. The step has no parameters in the derived-layer
  builder.

## Output

One row per non-null input geometry:

- Geometry: convex hull of that feature (point / line / polygon
  depending on the input).
- Properties: copied from the source row.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Convex hulls for this layer**.
3. Optionally edit the title.
4. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result.

### From the new-item wizard
![Derived layer recipe with a Convex hull step](/help/analysis/convex-hull-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Convex hull** step.
4. Save.

## Examples

- **Fill concave parcels**. Source: parcel polygons with bays.
  Output: each parcel as its convex outline for a simpler
  selection target.
- **Point cloud per-cluster hulls**. After you already have one
  multipoint (or multipolygon) feature per cluster, convex hull
  turns each into a polygon footprint. Building those clusters is
  a separate step.

## Notes

- **Per-feature only in v1.** There is no "hull of all input
  features" switch on this generator.
- **Points and short lines.** A single point stays a point; two
  points become a line; three or more become a polygon.
- **Multipart inputs** produce one hull of the combined parts.
