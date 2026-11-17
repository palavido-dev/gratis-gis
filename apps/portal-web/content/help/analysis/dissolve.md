---
id: analysis-dissolve
title: Dissolve
summary: Merge every input geometry into one combined feature via PostGIS ST_Union. Attributes are dropped.
category: analysis
order: 60
complexity: basic
tags:
  - analysis
  - derived-layer
  - dissolve
related:
  - items-derived-layer
  - analysis-group-by
---

A **dissolve** step merges every input geometry into a **single**
feature with PostGIS `ST_Union`. There is no key field and no
attribute aggregation on this path: the output has empty
properties.

Use when you want one combined shape — a total extent, a
boundary-cleanup union of same-area tiles you already filtered,
or a single mask polygon for a later clip / erase.

If you need one polygon **per attribute value** (land-use
categories, ownership, zoning) plus counts or sums, use
[Group by](analysis-group-by) (always `ST_Union` per group) instead.
That is the shipped keyed path.

## Inputs

- **Source layer**. Any geometry type. Null geometries are
  skipped. The step has no parameters in the derived-layer
  builder.

## Output

Exactly one feature (when the source has at least one non-null
geometry):

- Geometry: the union of every input geometry (often a
  multipolygon when parts do not touch).
- Properties: empty (`{}`). Source attributes are not carried
  forward — there is no canonical way to pick which `name` wins
  among dozens of input rows.

Downstream steps that need a named field will fail validation if
they sit after dissolve. Filter or calculate before dissolving,
or use group-by when you need keys and aggregates.

## How to use it on its own

### From Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Dissolve this layer**.
3. Optionally edit the title.
4. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. Attributes are
dropped on this path.

### From the new-item wizard

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Dissolve** step (no options to fill in).
4. Save.

The builder shows a short note that attributes are dropped.

## Examples

- **Single overall extent**. Source: any polygon layer. Output:
  one multipolygon that is the union of every input. Useful as a
  quick "what's the total coverage" reference or as a clip mask.
- **Pre-filtered union**. Filter parcels to one owner first, then
  dissolve — one shape for that owner without inventing a key
  field on dissolve itself.

## Dissolve vs. group-by

Both can merge geometries. The differences:

- **Dissolve** (this step) is the simple path: one union of the
  whole input, no attributes. Prefer it when that is all you need.
- **Group by** is the path when you also want group keys and
  aggregates (count, sum, average, …) alongside `ST_Union`
  geometry per key.

## Notes

- **Non-adjacent parts become multipolygons.** Scattered parcels
  that you dissolve together produce one multipolygon feature.
- **Internal holes can survive** when they are rings in the
  unioned geometry.
- **Slow on huge inputs.** Dissolving millions of polygons can
  take minutes; filter first or run off-hours.
- **No key-field dissolve here.** That wording in older docs was
  wrong for this generator; use group-by.
