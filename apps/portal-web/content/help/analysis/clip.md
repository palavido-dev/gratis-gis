---
id: analysis-clip
title: Clip
summary: Keep only the parts of input features that fall inside a clip polygon. Cookie-cutter style.
category: analysis/overlay
order: 80
complexity: basic
tags:
  - analysis
  - derived-layer
  - clip
related:
  - items-derived-layer
  - items-geo-boundary
---

A **clip** step trims each input feature to the parts that fall
inside a clip polygon. Features entirely outside drop out;
features that cross the polygon boundary are cut.

This is the spatial "intersect with this shape" operation.
Cookie-cutter: hand it a parcel layer and a city boundary, get
back the parcels inside the city, with parcels on the edge
trimmed at the boundary.

## Inputs

- **Source layer**. Any geometry type (points, lines, or polygons).
- **Clip layer**. Another **data layer** you can read. Prefer a
  polygon layer as the cookie-cutter. The portal unions that
  layer's geometries and intersects the source against the result.
  Geo-boundary items and pasted GeoJSON are not a separate clip
  input on this path; put the mask in a data layer first.

## Output

A new layer with the source's schema. Each row's geometry is
`ST_Intersection(source.geometry, clip)`. Rows whose geometry
doesn't intersect the clip drop out entirely; rows whose
geometry is entirely inside come through unchanged.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Clip this layer**.
3. Pick the cookie-cutter data layer.
4. Click **Create derived layer**.

That posts a single-step clip recipe to the portal. The job runs
on PostGIS on the server. Expect a short server job, not an
instant browser result. Not gated on the optional server-heavy
analysis tier.

### From the new-item wizard

![Derived layer recipe with a Clip by another layer step](/help/analysis/clip-analyze-guide.png)

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Clip by another layer** step.
4. Pick the other data layer.
5. Click **Create item**.

## Example

You have a state-wide road network. You want just the segments
inside one county. Add a Clip step with the county's geo
boundary as the clip polygon. Output is the road segments
trimmed to the county line.

## Clip vs. spatial join with "within"

- **Clip** trims geometry; the output's geometry is the
 intersected piece. Roads sticking out beyond the county line
 are cut at the line.
- **Spatial join with within** keeps the whole input geometry
 if any part is inside the join polygon. Same roads, kept whole
 if they're "in" the county at all.

Pick clip when the geometry needs to stay within the polygon;
pick spatial-join-with-within when you want intact features
plus an attribute identifying which polygon they're in.

## Notes

- **Clip a polygon by a polygon** produces a polygon. Common
 case for "limit this layer to the project area".
- **Clip a line by a polygon** produces line segments at the
 boundary cut.
- **Clip a point by a polygon** is equivalent to a filter
 "points inside this polygon"; same result, both work.
- **The clip polygon's coordinate system** is reconciled
 automatically.
