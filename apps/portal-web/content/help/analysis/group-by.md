---
id: analysis-group-by
title: Group by
summary: Roll up rows by one or more keys, producing aggregates (count, sum, average, min, max) per group.
category: analysis
order: 50
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - group-by
  - aggregate
related:
  - items-derived-layer
  - analysis-spatial-join
  - analysis-dissolve
---

A **group-by** step rolls up rows by one or more key fields,
producing one output row per group with computed aggregates.

Use after a spatial-join, after a filter, or directly on a source
layer when you want a summary.

## Inputs

- **Source layer**.
- **Group keys**: one or more fields whose distinct combinations
 define the groups.
- **Aggregates**, each a `(function, field, output name)`:
  - **count**(*): number of rows per group.
  - **sum**(field): numeric total.
  - **avg**(field): average.
  - **min** / **max**(field): extremes.
  - **first** / **last**(field, ordered by another field): first or
    last value when ordered.
  - **collect_into_array**(field): JSON array of values.
- **Geometry strategy** (for spatial outputs):
  - **Drop**: output rows have no geometry (non-spatial output).
  - **Bounding box**: union bbox of each group's geometries.
  - **Convex hull**: convex hull of each group's geometries.
  - **First**: the first row's geometry (cheap, semi-arbitrary).
  - **Dissolve**: union of geometries per group. If you only want
    one union of the whole layer with no keys or aggregates, use
    the plain [Dissolve](analysis-dissolve) step instead.

## Output

One row per distinct combination of group keys. Schema is the
group keys + the aggregates. Geometry per the chosen strategy.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Group by** step.
4. Pick **group keys**.
5. Define each **aggregate**.
6. Pick a **geometry strategy**.
7. Save.

## Examples

- **Hydrants per parcel** (after a spatial-join).
 Group key: `parcel_id`. Aggregate: `count(*) as hydrant_count`.
 Geometry strategy: drop (non-spatial result) or join back to
 parcels for the spatial result.
- **Average inspection score per neighborhood**.
 Group key: `neighborhood`. Aggregate: `avg(score)`. Geometry:
 dissolve to neighborhood boundaries.
- **Number of incidents per category, monthly**. Two group
 keys: `category`, `month_start`. Aggregate: `count(*)`.
 Geometry: drop.

## Notes

- **NULL is a group**. Rows with NULL in a group key are
 grouped together under "NULL". Filter them out first if you
 don't want that.
- **Large groups are slow**. The default geometry strategy
 (`first`) is cheap; `dissolve` on a 100k-feature group can be
 minutes. Pick by what the downstream consumer needs.
- **Cardinality drops sharply**. The output row count is the
 number of distinct group-key combinations. A million-row layer
 grouped by `month_start` produces ~12 rows per year of data.
