---
id: analysis-erase
title: Erase
summary: Keep only the parts of input features that fall outside an erase mask. The geometric inverse of clip.
category: analysis
order: 81
complexity: basic
tags:
  - analysis
  - derived-layer
  - erase
related:
  - analysis-clip
  - items-derived-layer
  - items-geo-boundary
---

An **erase** step keeps the parts of each input feature that fall
**outside** an erase mask. Features entirely covered by the mask
drop out; features that cross the mask boundary are cut.

This is the geometric inverse of [Clip](/help/analysis/clip). Hand
it a parcel layer and a flood zone, get back the parcels outside
the flood, with parcels on the edge trimmed at the boundary.

## Inputs

- **Source layer**. Any geometry type (points, lines, or polygons).
- **Erase mask**. Another **data layer** you can read. Prefer a
  polygon layer as the mask. The portal unions that layer's
  geometries and differences the source against the result.
  Geo-boundary items and pasted GeoJSON are not a separate erase
  input on this path; put the mask in a data layer first.

## Output

A new layer with the source's schema. Each row's geometry is
`ST_Difference(source.geometry, mask)`. Rows whose geometry is
fully covered by the mask drop out; rows that never touch the
mask come through unchanged.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Erase this layer**.
3. Pick the erase-mask data layer.
4. Click **Create derived layer**.

That posts a single-step erase recipe to the portal. The job runs
on PostGIS on the server. Expect a short server job, not an
instant browser result. Not gated on the optional server-heavy
analysis tier.

### From the new-item wizard

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add an **Erase** step.
4. Pick the erase-mask data layer.
5. Create the item.

## What it is not

- Not an in-browser DuckDB erase. Meter-accurate difference needs
  PostGIS on the server.
- Not a paint-over editor that deletes features in place. Erase
  creates a new derived layer; the source stays untouched.
- Not Spatial Analyst Erase licensing. Same idea, free on your
  PostGIS.
