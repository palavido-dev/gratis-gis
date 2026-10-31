---
id: analysis-buffer
title: Buffer
summary: Expand each input feature outward (or inward) by a fixed distance to produce a polygon at that offset.
category: analysis
order: 40
complexity: basic
tags:
  - analysis
  - derived-layer
  - buffer
related:
  - items-derived-layer
  - analysis-filter
---

A **buffer** produces a polygon around each input feature at a
fixed distance. Points become circles. Lines become long thin
polygons (think road right-of-way). Polygons grow outward (or
shrink inward with a negative distance).

This page documents the Buffer step in isolation. It's a single
derived-layer step and that's all it does on its own. Combine it
with other steps via a derived layer's pipeline.

## Inputs

- **Source layer**: any data layer or another derived layer.
- **Distance**: a number, positive (outward) or negative (inward
 on polygons).
- **Units**: meters, feet, kilometers, miles.

## Output

A new layer whose geometry is `ST_Buffer(source.geometry, distance)`
for each input row. Attributes are copied from the source row
verbatim.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Buffer this layer**.
3. Enter the distance and unit (meters, feet, kilometers, …).
4. Click **Create derived layer**.

That posts a single-step buffer recipe to the portal. The job runs
on PostGIS on the server — geodesic meters, not an in-browser
degree buffer. The Analyze SQL builder deliberately does **not**
offer meter buffers in DuckDB-WASM (no PROJ data in that build),
so this guide is the honest path.

Share a direct link with `?tool=buffer` (and `&layer=<sublayerId>`
on multi-layer items) plus `#data`, for example
`/items/<id>?tool=buffer&layer=<key>#data`. The Data tab opens
Analyze with the Buffer form already expanded.

The Analyze **Past runs** shelf lists your earlier derived layers
for this source. **Re-run** posts a new private copy of the same
recipe; **Edit & re-run** opens this Buffer form again.

From a map, open the layer kebab on a data-layer source and choose
**Buffer…** — that opens the same deep link in a new tab.

### From the new-item wizard

1. Open the new-item wizard and pick **Derived layer**.
2. Pick a **Source**. The layer you want to buffer.
3. Add a **Buffer** step.
4. Enter the distance and pick the unit.
5. Click **Save**.

That's the whole single-step recipe. Nothing else is required.
Derived-layer buffer is part of the always-on PostGIS analysis
path; it is **not** gated on the optional `server-heavy`
`ANALYSIS_TIERS` worker.

## Example

You have a points layer of fire hydrants and want to know the
area each one covers. Buffer the layer by **300 feet**. The
output is a polygon layer where each polygon is the 300-foot
service area of one hydrant.

That's it. No dissolve. No centroid. No "first you join, then
you...". Just buffer.

## Notes

- **Distance is geodesic.** We project to a local equal-area CRS,
 buffer there, then reproject the result. This makes the
 300-foot example actually 300 feet on the ground regardless of
 the layer's source CRS.
- **Negative distances** only do something useful on polygon
 inputs. A negative-buffered point becomes the empty geometry
 (and is dropped from the output).
- **Buffered geometry doesn't update live** if the source layer
 edits geometry. Buffered layers are materialized. Hit the
 **Refresh** button on the derived layer's detail page to
 recompute.
