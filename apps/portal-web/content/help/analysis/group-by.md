---
id: analysis-group-by
title: Group by
summary: Roll up rows by group keys with count/sum/avg/min/max/first aggregates; geometry is always ST_Union per group.
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

A **group-by** step (builder label **Group by + aggregate**)
collapses input rows to one output feature per distinct
combination of group keys. Geometry for each group is always
PostGIS `ST_Union` of the group's input geometries. Attributes
are the group keys plus your declared aggregates.

Use after a spatial-join, after a filter, or directly on a source
layer when you want a keyed summary. If you only need **one**
union of the whole layer with no keys and no aggregates, use the
plain [Dissolve](analysis-dissolve) step instead.

## Inputs

- **Source layer**.
- **Group keys** (`groupBy`): zero to eight field names. Distinct
  combinations define the groups. An **empty** key list collapses
  the whole input to a single feature (union + aggregates only).
- **Aggregates** (`aggs`): up to 16 entries, each
  `(op, field?, outputName)`:
  - **count** — row count per group (`field` unused).
  - **sum** / **avg** / **min** / **max** — numeric field.
  - **first** — first value of a field in the group (no order-by
    control).

**Not options:** last, collect_into_array, or a geometry strategy
picker (Drop / Bounding box / Convex hull / First / Dissolve).
Output geometry is always the union of each group.

## Output

One row per distinct group-key combination (or one row when
`groupBy` is empty):

- Geometry: `ST_Union` of the group's non-null input geometries
  (often a multipolygon when parts do not touch).
- Properties: each group key (original name) plus each aggregate
  under its `outputName`.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Group by** step.
4. Pick **group keys** (or leave empty for a single overall rollup).
5. Add each **aggregate** (op, field when required, output name).
6. Save.

There is no separate geometry-strategy control.

## Examples

- **Hydrant count per parcel id** (after a spatial join that
  brought `parcel_id` onto hydrant rows, or on parcels that
  already carry a count). Group key: `parcel_id`. Aggregate:
  `count` → `hydrant_count`. Geometry: union of features in each
  parcel group.
- **Average inspection score per neighborhood**. Group key:
  `neighborhood`. Aggregate: `avg(score)` → `avg_score`.
- **Single overall count**. Empty group keys. Aggregate:
  `count` → `n`. Same shape idea as dissolve, but you keep an
  aggregate attribute instead of dropping properties.

## Notes

- **NULL is a group**. Rows with NULL in a group key are grouped
  together. Filter them out first if you do not want that.
- **Large unions are slow**. Dissolving a huge group via
  `ST_Union` can take minutes; filter first when you can.
- **Cardinality drops**. Output row count is the number of
  distinct key combinations (or 1 when keys are empty).
- **Keyed dissolve lives here.** The no-param
  [Dissolve](analysis-dissolve) step unions everything and drops
  attributes. For one polygon per attribute value plus counts or
  sums, use this step.
