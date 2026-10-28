---
id: analysis-simplify
title: Simplify
summary: Drop vertices within a tolerance of a straight line via PostGIS ST_Simplify. Attributes are kept.
category: analysis
order: 65
complexity: basic
tags:
  - analysis
  - derived-layer
  - simplify
related:
  - items-derived-layer
  - analysis-buffer
  - analysis-dissolve
---

A **simplify** step reduces geometry detail with PostGIS
`ST_Simplify` (Douglas–Peucker). Vertices that lie within the
tolerance of a straight line between their neighbors are dropped.
Attributes are copied from the source row.

Use when you want lighter polygons or lines for display, export,
or a later analysis step — not when you need topology preserved
(holes and shared edges can break; that stricter path is not
offered here).

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped.
- **Tolerance**. A number greater than zero.
- **Unit**. Meters, feet, kilometers, or miles. The server
  converts to degrees of latitude before calling `ST_Simplify`
  (geometries are stored in EPSG:4326). Soft ceiling: 100 km.

## Output

One row per non-null input geometry:

- Geometry: `ST_Simplify` of the input (may be empty if the
  tolerance collapses the shape).
- Properties: copied from the source row.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Simplify this layer**.
3. Enter the tolerance and unit.
4. Optionally edit the title.
5. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. Meter-honest
tolerance runs on PostGIS — Analyze does not invent an in-browser
simplify.

### From the new-item wizard

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Simplify** step.
4. Enter tolerance and unit.
5. Save.

## Examples

- **Lighter parcel outlines**. Source: parcels. Tolerance:
  2 meters. Output: the same parcels with fewer vertices for
  faster map draw.
- **Export-friendly roads**. Source: detailed centerlines.
  Tolerance: 10 meters. Output: smoother lines for a PDF or
  GeoJSON share.

## Notes

- **Not topology-preserving.** `ST_Simplify` (not
  `ST_SimplifyPreserveTopology`) is the fast path. Adjacent
  polygons can develop gaps or overlaps after a large tolerance.
- **Empty results are possible** when the tolerance is large
  relative to the feature size.
- **Degree conversion is approximate.** Tolerance uses ~111,320 m
  per degree of latitude; at high latitudes longitude degrees are
  shorter, so simplification can be slightly more aggressive.
- **Soft max 100 km.** Same ceiling as Buffer — wide enough for
  any real “smooth this” use, narrow enough to refuse a
  pathological misclick.
