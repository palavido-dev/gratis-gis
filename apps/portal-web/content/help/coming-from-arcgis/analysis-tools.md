---
id: coming-from-arcgis-analysis
title: Analysis tools compared
seoTitle: "ArcGIS analysis tools and their GratisGIS equivalents"
summary: "Which GratisGIS analysis step replaces ArcGIS tools such as Buffer, Clip, Dissolve, Spatial Join and Select by Location. Results stay live and use no credits."
category: getting-started/coming-from-arcgis
order: 60
complexity: intermediate
tags:
  - migration
  - analysis
  - geoprocessing
  - derived-layer
related:
  - items-derived-layer
  - analysis-workflows
  - coming-from-arcgis-arcade
---

In ArcGIS Online, an analysis tool runs once, spends credits, and
writes a new hosted layer. In GratisGIS the same jobs are steps on a
[derived layer](/help/items/derived-layer). A derived layer stores
the recipe, not a copy of the result. PostGIS runs the recipe on
every read, so edits to the source show up in the result on the next
request. Nothing is metered.

Common one-step jobs are also on a data layer's **Analyze** tab,
which creates the derived layer for you.

## Tool by tool

| ArcGIS tool | In GratisGIS | Notes |
|---|---|---|
| Buffer, Create Buffers | [Buffer](/help/analysis/buffer) | Meters, feet, kilometers or miles, measured on the ground. |
| Clip, Extract Data (clip) | [Clip](/help/analysis/clip) | Keeps the parts inside the clip polygon. |
| Erase, Overlay Layers (erase) | [Erase](/help/analysis/erase) | Keeps the parts outside the mask. |
| Dissolve with no fields | [Dissolve](/help/analysis/dissolve) | Merges everything into one feature. Attributes are dropped. |
| Dissolve by field, Dissolve Boundaries | [Group by](/help/analysis/group-by) | One feature per group, with count, sum, average, min, max or first. |
| Summary Statistics | [Group by](/help/analysis/group-by) | The geometry of each group is merged too. |
| Select by Attributes, Filter | [Filter](/help/analysis/filter) | Keeps the rows that match an expression. |
| Select by Location | [Spatial filter](/help/analysis/spatial-filter) | Keeps rows that match a spatial test against another layer. No attributes are joined. |
| Spatial Join, Join Features | [Spatial join](/help/analysis/spatial-join) | Within, intersects or nearest. Attaches a count or chosen attributes. |
| Summarize Within (point counts) | [Spatial join](/help/analysis/spatial-join) with a count | Counts features of one layer inside each feature of another. |
| Near | [Nearest neighbor](/help/analysis/nearest-neighbor) | Distance in meters to the closest other feature in the same layer. |
| Calculate Field | [Calculate field](/help/analysis/calculate) | Uses the [expression language](/help/reference/expression-language), not Arcade or Python. |
| Calculate Geometry Attributes | [Calculate geometry](/help/analysis/calculate) | Length, perimeter or area with a unit. |
| Feature To Point | [Centroid](/help/analysis/centroid) | One point at each feature's center. |
| Feature Vertices To Points | [Vertices](/help/analysis/vertices) | One point per vertex. The row count can grow a lot. |
| Minimum Bounding Geometry (convex hull) | [Convex hull](/help/analysis/convex-hull) | One hull per feature. |
| Minimum Bounding Geometry (envelope) | [Bounding box](/help/analysis/bbox) | One rectangle per feature. |
| Simplify Line, Simplify Polygon | [Simplify](/help/analysis/simplify) | Drops vertices within a tolerance. |
| Densify | [Densify](/help/analysis/densify) | Adds vertices up to a maximum segment length in meters. |
| Create Fishnet, Generate Tessellation (squares) | [Fishnet](/help/analysis/fishnet) | Square grid over a polygon layer. |
| Contour (from points) | [Contour](/help/analysis/contour) | Lines from a numeric field on a point layer. |
| Zonal Statistics as Table | [Zonal statistics](/help/analysis/zonal-stats) | Not a derived-layer step. Runs from an elevation layer's page and writes a new data layer. |
| Sort, then select the top rows | [Top N](/help/analysis/top-n) | Highest or lowest N by a numeric field. |
| Subset Features | [Random sample](/help/analysis/random-sample) | A repeatable subset by percentage or count. |

## Chaining steps

ModelBuilder chains tools into a model. A derived layer chains steps
in order: filter, then buffer, then spatial join, for example. A
derived layer can also read another derived layer, so a shared
first step can feed several results. See
[Workflows](/help/analysis/workflows).

## Differences worth knowing

- **Results are live.** There is no output layer to refresh or
  re-run when the source changes. To freeze a result at a point in
  time, export it.
- **Distances are real distances.** Buffer, simplify, densify and
  nearest neighbor work in meters or other ground units, not in
  degrees.
- **Analysis runs on your server.** A heavy recipe over a large layer
  costs time on each read. Filter early in the chain to keep later
  steps small.
- **Raster analysis is narrow.** Zonal statistics and contours are
  there. Most of the raster toolset in ArcGIS Pro is not.

## Not here yet

- Network analysis: routing, service areas, closest facility.
- Geocoding in batch as an analysis step. Address CSVs are geocoded
  on upload instead. See [Uploading a CSV](/help/getting-started/uploading-csv).
- Hot spot analysis, interpolation, density surfaces and other
  spatial statistics tools.
- Python or Arcade inside a step. For custom Python, see
  [Scripts](/help/reference/scripts).
