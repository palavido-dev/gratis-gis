---
id: analysis-centroid
title: Centroid
summary: Replace each feature's geometry with a single point at its geometric center.
category: analysis
order: 70
complexity: basic
tags:
  - analysis
  - derived-layer
  - centroid
related:
  - items-derived-layer
  - analysis-buffer
---

A **centroid** step replaces each feature's geometry with a
single point at the feature's geometric center
(`ST_Centroid`). Attributes are kept; only the geometry changes
from polygon (or line) to point.

Use when a downstream step or rendering wants point geometry:
labeling at a single anchor, clustering, point-symbol rendering
of a polygon layer, or input to a join that expects points.

## Inputs

- **Source layer**. Any geometry type. Points stay points at the
  same location; lines become midpoints; polygons become geometric
  centroids (which can fall outside a concave shape).

## Output

A new layer with point geometry. Attributes copied verbatim.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Centroids for this layer**.
3. Optionally edit the title.
4. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. The in-browser
SQL starter still offers `ST_Centroid` for ad-hoc queries; the
guided control is the honest path when you want a saved layer.

Share a direct link with `?tool=centroid` (and `&layer=<sublayerId>`
on multi-layer items) plus `#data`.

### From the new-item wizard

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Centroid** step.
4. Save.

## Example

You have a parcel polygon layer and want a "parcel centroids"
point layer as the click target on a basemap-style map (polygons
as decoration, points as the interactive layer). Use the Analyze
shortcut or a Centroid step on a derived layer.

## Notes

- **Geometric centroid only.** The portal runs PostGIS
  `ST_Centroid`. Pole of inaccessibility and bounding-box center
  are not separate options on this path.
- **Centroid of a multipart geometry** is one point: the centroid
  of the combined geometry. Not one per part.
- **Linestrings have centroids too.** The midpoint of the line.
- **NULL geometry features** produce NULL output points and drop
  from rendering.
