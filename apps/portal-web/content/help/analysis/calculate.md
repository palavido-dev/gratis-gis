---
id: analysis-calculate
title: Calculate
summary: Add a computed column from field expressions, or add length / perimeter / area via Calculate geometry.
category: analysis
order: 20
complexity: basic
tags:
  - analysis
  - derived-layer
  - calculate
related:
  - items-derived-layer
  - analysis-filter
  - reference-expression-language
---

Two related derived-layer steps add attributes without changing
geometry:

1. **Calculate field** — one new column from an expression over
   existing attributes (`{{field}}` refs and the shared expression
   dialect).
2. **Calculate geometry** — one numeric column from the feature
   geometry (length, perimeter, or area) in a chosen unit.

They are separate tools in the builder. Do not paste
`area_m2()` into a calculate-field expression; that helper is not
in the dialect.

## Calculate field

### Inputs

- **Source layer**.
- **Output field name**.
- **Expression** using the
  [expression language](reference-expression-language). Field
  references use `{{name}}` braces.

### Output

Source rows unchanged, plus the new field. Geometry unchanged.

### Examples

- **Full name**:
  `concat({{first}}, ' ', {{last}})` (or `{{first}}` / `{{last}}`
  with `||` where the surface allows).
- **Flag from attributes**:
  `if({{status}} = 'closed', false, true)`.

See the expression reference for the shipped function list
(`upper`, `lower`, `length`, `concat`, `coalesce`, `abs`,
`round`, `floor`, `ceil`, `if`). Geometry helpers such as
`area_m2()` / `centroid_x()` are **not** available here.

## Calculate geometry

### Inputs

- **Source layer** (any geometry; null geometries skip the measure).
- **Measurement**: `length`, `perimeter`, or `area`.
- **Unit**: length units (meters, feet, …) or area units
  (square meters, acres, hectares, …) matching the measurement.
- **Field name**: the new numeric column (letters / digits /
  underscore).

Computation uses PostGIS geography (`ST_Length` / `ST_Area`, with
`ST_Boundary` for perimeter) and converts to the chosen unit.

### Output

Source attributes plus the new numeric field. Geometry unchanged.

### Examples

- **Parcel acres**: measurement `area`, unit acres, field
  `acres`.
- **Road length in miles**: measurement `length`, unit miles,
  field `miles`.
- **Polygon perimeter in meters**: measurement `perimeter`, unit
  meters, field `perimeter_m`.

## How to use them

### Calculate geometry from Analyze (guided)

1. Open a data layer and switch to the **Analyze** tab.
2. Click **Calculate geometry for this layer**.
3. Pick length, perimeter, or area; choose a unit; name the field.
4. Optionally edit the title.
5. Click **Create derived layer**.

The portal creates a private derived layer and opens it. Expect a
short server job, not an instant browser result. Meter-honest
measures run on PostGIS geography — Analyze does not invent
`area_m2()` expression helpers.

### From the new-item wizard
![Derived layer recipe with a Calculate geometry step](/help/analysis/calculate-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add **Calculate field** and/or **Calculate geometry**.
4. Fill expression or measurement / unit / field name.
5. Save.

## When NOT to use Calculate field

- **Geometry measures**. Use **Calculate geometry**, not fake
  expression helpers.
- **One-off popup formatting**. Popup templates can interpolate
  fields without a derived column.
- **Per-user values**. Calculate is per-row at materialization
  time; it does not know who the viewer is.

## Notes

- **Materialization time.** Refresh the derived layer when the
  source changes.
- **NULL propagates** through arithmetic. Use `coalesce` before
  computing when you need a default.
