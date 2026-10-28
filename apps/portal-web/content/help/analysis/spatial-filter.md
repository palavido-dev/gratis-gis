---
id: analysis-spatial-filter
title: Spatial filter
summary: Keep input rows whose geometry matches a predicate against another data layer (or inline geometry). No attribute join.
category: analysis
order: 31
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - spatial-filter
related:
  - items-derived-layer
  - analysis-spatial-join
  - analysis-clip
  - analysis-erase
---

A **spatial filter** step keeps upstream rows whose geometry
satisfies a spatial predicate against an **other source**. Left
rows that pass through are unchanged: same attributes, same
geometry, no row multiplication.

This is the filtering counterpart to
[Spatial join](analysis-spatial-join). Spatial join decorates with
counts or attributes; spatial filter only drops non-matching rows.

## Inputs

- **Source (pipeline input)**. Rows kept or dropped; schema
  unchanged.
- **Other source**:
  - In the derived-layer wizard: another portal **data layer**
    you can read (item + optional sublayer).
  - In tool recipes: may also be an **inline geometry** (for
    example a drawn AOI resolved at run time).
- **Predicate**:
  - **intersects** — any overlap (`ST_Intersects`).
  - **within** — input geometry is entirely inside the other
    (`ST_Within`).
  - **contains** — input geometry contains the other
    (`ST_Contains`).
  - **touches** — boundaries touch without interior overlap
    (`ST_Touches`).
  - **near** — within a distance in **meters** on geography
    (`ST_DWithin`). Distance is required for near; positive,
    soft max 1,000 km.
- You must be allowed to read the other data layer (same ACL
  check as other pipeline `otherSource` edges).

## Output

- Geometry and attributes: from the pipeline input (unchanged
  for kept rows).
- Row count: at most the input count (null input geometries are
  skipped).
- **Not** an attribute join: no prefixed columns, no match count
  column, no cartesian explode.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a **Source**.
3. Add a **Spatial filter** step.
4. Pick the **other** data layer.
5. Choose a predicate (and meters if **near**).
6. Save.

## Examples

- **Features inside a park**. Source: trees. Other: park
  boundary. Predicate: **within**. Output: trees inside the park.
- **Parcels near a corridor**. Source: parcels. Other: proposed
  alignment. Predicate: **near**, 500 meters. Output: parcels
  within 500 m of the alignment.
- **Buildings that touch a floodplain**. Source: buildings.
  Other: floodplain polygons. Predicate: **touches** (or
  **intersects** if overlap should count too).

## Spatial filter vs. spatial join vs. clip / erase

| Need | Use |
| --- | --- |
| Keep / drop rows by location | **Spatial filter** |
| Add count or attributes from matches | **Spatial join** |
| Cut geometry to a mask | **Clip** |
| Subtract a mask from geometry | **Erase** |

## Notes

- **Near distance is meters** on the spheroid, not degrees.
- **Contains is on this step**, not on spatial join (join only
  offers within / intersects / nearest).
- **Inline geometry** is a recipe/runtime path; the derived-
  layer wizard hard-codes a data layer as the other source.
- **Not Select Layer By Location parity.** Only the predicates
  listed above ship.
