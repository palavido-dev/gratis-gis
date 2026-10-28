---
id: analysis-spatial-join
title: Spatial join
summary: Attach a count or selected attributes from a second data layer onto each input feature via within, intersects, or nearest.
category: analysis/select-and-calculate
order: 30
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - spatial-join
related:
  - items-derived-layer
  - analysis-spatial-filter
  - analysis-group-by
  - analysis-clip
---

A **spatial join** step looks up matches from a second **data
layer** (the other source) for each input feature, using a spatial
predicate. The output keeps the input geometry and adds either a
match count or selected attributes from the first match.

There is **no one-to-many / cartesian** path: matching pairs never
explode into multiple output rows. Use attribute strategy
**count** when you care about multiplicity.

## Inputs

- **Source (pipeline input)**. Features keep their geometry; their
  rows stay one-to-one in the output.
- **Other source**. A portal **data layer** you can read (not
  another derived layer in v1). Pick item + sublayer in the
  builder.
- **Predicate**:
  - **intersects** — any overlap.
  - **within** — input geometry is entirely inside the other
    feature.
  - **nearest** — closest other feature within an optional max
    distance in meters (default 1,000 m; soft max 1,000 km).
- **Attribute strategy**:
  - **count** — add one numeric column (`joined_count` by
    default) with how many other features matched.
  - **first** — copy named fields from one matching other
    feature. You must list `attrsToKeep` (up to 16). Prefixed
    names default to `joined_<field>`.
- **Attribute prefix** (optional). Defaults to `joined_`. Must
  not collide with existing upstream field names.

**Not options:** Contains, Within distance as its own predicate,
one-to-many cardinality, or "bring all join fields by default".
Distance filtering beyond nearest's max meters belongs on a
separate [Spatial filter](analysis-spatial-filter) step when you
need it (including **contains** / **touches** / **near**).

## Output

- Geometry: from the pipeline input (unchanged).
- Attributes: input fields plus either `{prefix}count` or the
  prefixed `attrsToKeep` columns (`first` strategy; nullable when
  nothing matched).
- Row count: same as the input (null geometries on the input are
  skipped by the join SQL).

## How to use it on its own
![Derived layer recipe with a Spatial join step](/help/analysis/spatial-join-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a **Source**.
3. Add a **Spatial join** step.
4. Pick the **other** data layer.
5. Choose **intersects**, **within**, or **nearest** (and max
   meters for nearest).
6. Choose **count** or **first** (with field names for first).
7. Save.

## Examples

- **Hydrant count per parcel**. Source: parcels. Other: hydrants.
  Predicate: intersects (or within, if hydrants should sit fully
  inside). Strategy: **count**. Output adds `joined_count`.
- **Nearest fire station name**. Source: parcels. Other: fire
  stations. Predicate: **nearest**, max meters as needed.
  Strategy: **first**, attrs to keep: `name`. Output adds
  `joined_name`.
- **Neighborhood label on parcels**. Source: parcels. Other:
  neighborhoods. Predicate: **within**. Strategy: **first**,
  attrs to keep: `name`.

## Notes

- **No cartesian explode.** If a parcel intersects three
  hydrants, **count** returns `3` on one row; it does not emit
  three parcel copies. Pair with [Group by](analysis-group-by)
  only when you need aggregates on attributes you already joined.
- **Other source is data_layer only.** Derived-layer-as-join-side
  is not shipped.
- **Prefix collisions fail validation.** Change `attrPrefix` if
  `joined_count` (or a kept field name) already exists upstream.
- **NULL geometry** on either side does not produce a match for
  that pair; unmatched **first** columns are null.
