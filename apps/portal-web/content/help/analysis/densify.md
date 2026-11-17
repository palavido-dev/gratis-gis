---
id: analysis-densify
title: Densify
summary: Add vertices so no segment exceeds a meter-honest max length via PostGIS ST_Segmentize on geography. Attributes are kept.
category: analysis/geometry
order: 66
complexity: basic
tags:
  - analysis
  - derived-layer
  - densify
related:
  - items-derived-layer
  - analysis-simplify
  - analysis-buffer
---

A **densify** step adds intermediate vertices along input lines and
polygon boundaries so no segment exceeds the chosen max length.
It uses PostGIS `ST_Segmentize` on `geography`, so spacing is
meter-honest on Earth regardless of latitude. Attributes are
copied from the source row.

Use before a reprojection (to keep curves looking smooth after a
CRS change), for smoother along-line sampling, or as a preprocess
for fishnet / vertices work on long thin features. Point-only
input is an effective no-op (a point has no segments).

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped.
- **Max segment length**. A number that converts to at least
  1 meter.
- **Unit**. Meters, feet, kilometers, or miles. The server
  converts to meters before calling `ST_Segmentize` on geography.
  Soft ceiling: 100 km (same as Buffer / Simplify) so a tiny
  misclick cannot spawn millions of vertices.

## Output

One row per non-null input geometry:

- Geometry: the input with extra vertices on edges longer than
  the max segment length (bbox unchanged).
- Properties: copied from the source row.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Densify this layer**.
3. Enter the max segment length and unit.
4. Optionally edit the title.
5. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. Meter-honest
segment length runs on PostGIS — Analyze does not invent an
in-browser densify.

### From the new-item wizard
![Derived layer recipe with a Densify step](/help/analysis/densify-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Densify** step.
4. Enter max segment length and unit.
5. Save.

## Examples

- **Smoother roads after reproject**. Source: long highway
  centerlines. Max segment: 50 meters. Output: the same roads with
  vertices dense enough that a later projected view does not
  look like a chorded polyline.
- **Along-line samples**. Source: survey transects. Max segment:
  10 meters. Output: denser vertices for interpolation or
  fishnet prep.

## Notes

- **Min 1 m / max 100 km.** The generator refuses shorter or
  longer max segment lengths after unit conversion.
- **Geography, not planar degrees.** Length is interpreted in
  meters on the spheroid; do not enter "degree" values.
- **Does not change the envelope.** Vertices are inserted on
  existing edges only; the bounding box stays the same.
- **Pairs with Simplify.** Densify adds detail; Simplify removes
  it. Use densify when you need more vertices, not fewer.
