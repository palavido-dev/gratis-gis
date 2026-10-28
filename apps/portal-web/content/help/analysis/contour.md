---
id: analysis-contour
title: Contour
summary: Generate iso-lines from a numeric field on a point layer via a PostGIS TIN.
category: analysis
order: 100
complexity: advanced
tags:
  - analysis
  - derived-layer
  - contour
  - isolines
related:
  - items-derived-layer
  - analysis-fishnet
---

A **contour** step builds a Delaunay TIN from point features that
carry a numeric field, then emits **iso-lines** where that field
crosses chosen levels (`ST_DelaunayTriangles` plus edge
interpolation). Think elevation contours or signal-strength
isobars — lines of equal value.

Iso-polygons (filled bands), smoothing controls, and per-band
aggregates are **not** options on this path. Output is line
geometry with a `level` property only.

## Inputs

- **Source layer** of points with a numeric attribute. Fishnet
  cell centroids can work if you have already turned cells into
  points with a value; the generator itself expects point
  geometry for the TIN.
- **Value field**: the numeric attribute to contour on.
- **Levels mode**:
  - **Auto**: pick an interval (and optional min / max). At save
    time the portal reads the source min/max, builds the level
    list, and caches it on the recipe.
  - **Manual**: supply an explicit list of levels.
- Levels are capped (about 100) so a tiny interval on a huge
  range cannot explode the job.

## Output

A line layer. Each feature is a contour segment with:

- `level`: the contour value for that line.

No `level_top`, and no mean/count aggregates from the source.

## How to use it on its own
![Derived layer recipe with a Contour step](/help/analysis/contour-analyze-guide.png)


1. Start from a point layer that already has the numeric field
   (survey points, sample sites, or centroids you computed
   elsewhere).
2. New-item wizard → **Derived layer**.
3. Pick that layer as Source.
4. Add a **Contour** step.
5. Choose the value field, auto vs manual levels, and interval
   or level list.
6. Save.

Expect a server job. Dense point sets are expensive; prefer a
bbox-filtered source or coarser spacing when exploring.

## From a data layer Analyze tab

On a **point** data layer's **Analyze** tab, **Contour for this
layer** opens numeric field, auto interval, and optional min/max
controls and creates a private derived layer with a single
contour step (same PostGIS TIN path as above). Point layers only;
line and polygon layers do not show the chip. Manual level-list
authoring stays in Create → Derived layer. Expect a server job,
not an instant browser result.

## Example: elevation iso-lines

1. Source: elevation sample points with an `elev_m` field.
2. Contour on `elev_m`, mode auto, interval 10 (optional min/max
   to clip the range).
3. Output: line features tagged with `level` at 10 m steps across
   the sampled area.

For filled "service zone" bands, build polygons another way
(buffer, dissolve, or a dedicated service-area tool) — this step
does not emit iso-polygons.

## Notes

- **Input density matters.** Sparse points make coarse TINs and
  jagged lines; very dense clouds are slow (nearest-neighbor
  lookup in the SQL path).
- **Edges are interpolated** linearly along TIN triangle edges
  between adjacent sample values.
- **Coverage stops with the TIN.** Contours do not invent values
  outside the convex hull of the input points.
- **No smoothing slider.** What you see is the mathematical TIN
  intersection, not a cartographic smooth.
