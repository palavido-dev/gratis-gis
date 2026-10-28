---
id: analysis-bbox
title: Bounding box
summary: Replace each feature's geometry with its axis-aligned envelope via PostGIS ST_Envelope. Attributes are kept.
category: analysis/geometry
order: 74
complexity: basic
tags:
  - analysis
  - derived-layer
  - bbox
related:
  - items-derived-layer
  - analysis-convex-hull
  - analysis-centroid
  - analysis-dissolve
---

A **bounding box** (bbox) step replaces each feature's geometry
with its axis-aligned envelope (`ST_Envelope`). Attributes are
kept; row count is unchanged.

This is **per feature**, not one envelope for the whole layer.
For a single combined outline of every feature, use
[Dissolve](analysis-dissolve) (attributes dropped) or
[Group by](analysis-group-by) with empty keys when you also need
aggregates.

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped. The step has no parameters in the derived-layer
  builder.

## Output

One row per non-null input geometry:

- Geometry: closed rectangle polygon enclosing that feature
  (WGS84).
- Properties: copied from the source row.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Bounding boxes for this layer**.
3. Optionally edit the title.
4. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result.

### From the new-item wizard
![Derived layer recipe with a Bounding box step](/help/analysis/bbox-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Bbox** step.
4. Save.

## Examples

- **Lighter extent overlays**. Source: detailed building
  footprints. Output: one rectangle per building for overview
  maps or clustering by extent overlap.
- **Extent QA**. Source: survey polygons. Output: quick visual
  check that envelopes sit where expected.

## Notes

- **Per-feature only in v1.** There is no "envelope of all input
  features" switch on this generator.
- **Axis-aligned in the layer CRS** (stored as EPSG:4326). At high
  latitudes the geographic rectangle is not a planar square.
- **Cheaper than convex hull** when only the rectangle matters.
