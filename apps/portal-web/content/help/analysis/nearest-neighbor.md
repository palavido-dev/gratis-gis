---
id: analysis-nearest-neighbor
title: Nearest neighbor
summary: Add nearest_distance_m — geographic meters to the closest other feature in the same layer.
category: analysis
order: 42
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - nearest-neighbor
related:
  - items-derived-layer
  - analysis-top-n
  - analysis-spatial-join
  - analysis-calculate
---

A **nearest neighbor** step adds a numeric attribute
`nearest_distance_m`: the geographic distance in meters from each
feature to the closest **other** feature in the **same** pipeline
input (self-join on geography). Geometry is unchanged.

There is **no second layer** and **no K** (k-nearest list). For
distance to another layer, use
[Spatial join](analysis-spatial-join) with predicate **nearest**.

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped.
- **No parameters** in the derived-layer builder.

## Output

Source attributes plus `nearest_distance_m` (nullable number). A
single-row input yields NULL for that field (nothing else to
measure against). If the source already had a field named
`nearest_distance_m`, this step overwrites it.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Nearest neighbor** step.
4. Save.

## Examples

- **Isolation score**. Source: wells. Output adds meters to the
  nearest other well. Follow with [Top N](analysis-top-n) on
  `nearest_distance_m` ascending to list the most clustered, or
  descending for the most isolated.
- **QA for duplicates**. Very small `nearest_distance_m` values
  may flag near-duplicate points.

## Notes

- **O(N²) per read.** The join runs over the full input. For more
  than a few thousand features, expect slower materialization.
  Recipe `featureLimit` caps output rows but does not shrink the
  join input. A GIST / KNN path is not provisioned in v1.
- **Meters on the spheroid** via `ST_Distance` on geography —
  not planar degrees.
- **Same layer only.** Other-layer proximity is spatial join
  nearest, not this tool.
