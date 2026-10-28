---
id: analysis-zonal-stats
title: Zonal statistics
summary: Summarize a raster inside polygon zones (mean, min, max, sum, count).
category: analysis/summarize
order: 55
complexity: intermediate
tags:
  - analysis
  - raster
  - elevation
  - zonal
related:
  - analysis-contour
  - items-tile-layer
  - items-data-layer
---

Pick an elevation (or other raster) tile layer and a polygon data
layer. GratisGIS writes a new data layer whose features are the
zone polygons, each carrying `zonal_mean`, `zonal_min`, `zonal_max`,
`zonal_sum`, and `zonal_count` for the raster cells that fall inside
that zone.

## Where to run it

On an **elevation layer** item page, under Terrain analysis, choose
the zone data layer and click **Summarize elevation by zone**. The
server-heavy analysis worker must be enabled on the portal
(`ANALYSIS_TIERS` includes `server-heavy`).

## Limits (v1)

- At most 2,000 zones per job.
- Band 1 of the COG by default (optional `band` on the API).
- Zones without raster overlap are dropped from the output.

## Related

- [Contour](analysis-contour) for elevation isolines from the same
  terrain stack.
- [Data layer](items-data-layer) for what the output item is.
