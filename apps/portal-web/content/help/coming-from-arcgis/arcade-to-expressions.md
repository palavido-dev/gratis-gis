---
id: coming-from-arcgis-arcade
title: Arcade to expressions
seoTitle: "Arcade expressions in GratisGIS: translations and workarounds"
summary: "GratisGIS does not run Arcade. Common Arcade patterns translated into the expressions used by Filter and Calculate field steps, and what has no equivalent yet."
category: getting-started/coming-from-arcgis
order: 45
complexity: intermediate
tags:
  - migration
  - arcade
  - expressions
  - calculate
  - labels
  - popups
related:
  - analysis-calculate
  - analysis-filter
  - items-derived-layer
  - reference-expression-language
---

GratisGIS does not run Arcade. Web map imports from ArcGIS Online
drop Arcade expressions with a warning. Labels and popups take plain
field references such as `{name}`, and do not evaluate expressions.
Computed values come from the **Filter** and **Calculate field**
steps on a [derived layer](/help/items/derived-layer), which use a
small expression language of their own.

This page covers that expression language as the Filter and
Calculate field steps accept it today. It is smaller than Arcade.

## Where each kind of Arcade goes

| Arcade used for | In GratisGIS | Notes |
|---|---|---|
| Label expression | Label text with `{field}` references | Conditional labels need a computed column. See below. |
| Popup expression or attribute expression | Popup title and body with `{field}` references | Same: compute the column first, then show it. |
| Calculate Field with Arcade | **Calculate field** step on a derived layer | The column is computed on every read. |
| Filter or definition expression | **Filter** step, or a filter on the map layer | See [Filter](/help/analysis/filter). |
| Geometry functions (`Area`, `Length`) | **Calculate geometry** step | Length, perimeter and area with a unit. See [Calculate](/help/analysis/calculate). |
| Spatial lookups (`Intersects`, `FeatureSetByName`) | **Spatial join** or **Spatial filter** step | Expressions cannot read other layers. |
| Form calculations and relevance | Form **conditional logic** | See [Conditional logic](/help/forms/conditional-logic). |

## The expression language in one minute

- Fields: `{{status}}`. Names are case-sensitive.
- Text: single quotes, `'open'`.
- Compare with `==`, `!=`, `<`, `<=`, `>`, `>=`. A single `=` is
  not accepted.
- Combine with `AND`, `OR` and `NOT`.
- Math: `+`, `-`, `*`, `/`, `%`. Dividing by zero gives an empty
  value instead of an error.
- Join text with `~~` or `concat(...)`.
- Functions: `upper`, `lower`, `length`, `concat`, `coalesce`,
  `abs`, `round`, `floor`, `ceil` and `if(condition, then, else)`.

## Translating common patterns

| Arcade | GratisGIS expression |
|---|---|
| `$feature.status` | `{{status}}` |
| `$feature.a == 1 && $feature.b != 'x'` | `{{a}} == 1 AND {{b}} != 'x'` |
| `IIf($feature.acres > 5, 'Large', 'Small')` | `if({{acres}} > 5, 'Large', 'Small')` |
| `When($feature.p == 1, 'High', $feature.p == 2, 'Medium', 'Low')` | `if({{p}} == 1, 'High', if({{p}} == 2, 'Medium', 'Low'))` |
| `Decode($feature.code, 'A', 'Active', 'Other')` | `if({{code}} == 'A', 'Active', 'Other')` |
| `Concatenate([$feature.first, ' ', $feature.last])` | `concat({{first}}, ' ', {{last}})` |
| `Upper($feature.name)` | `upper({{name}})` |
| `Count($feature.name)` (text length) | `length({{name}})` |
| `DefaultValue($feature.owner, 'Unknown')` | `coalesce({{owner}}, 'Unknown')` |
| `IsEmpty($feature.owner)` | `coalesce({{owner}}, '') == ''` |
| `Round($feature.value, 2)` | `round({{value}} * 100) / 100` |
| `$feature.acres * 0.4047` | `{{acres}} * 0.4047` |

Notes on the less obvious rows:

- **Empty checks.** Comparing a field with `null` never matches,
  the same as in SQL. Use `coalesce` to turn an empty value into
  something you can compare, as in the `IsEmpty` row.
- **Rounding.** `round` takes one argument and rounds to a whole
  number. Multiply and divide to keep decimals.
- **Dates.** Date fields are ISO 8601 text and compare as text, so
  `{{inspected}} >= '2026-01-01'` works. There are no date functions
  and no date arithmetic yet. `DateDiff`, `Year` and `Now` have no
  translation.

## Conditional labels and popups

Labels and popups only fill in field values. To show "Open" or
"Closed" from a status code, compute the text once and label from
it:

1. Create a [derived layer](/help/items/derived-layer) from the data
   layer.
2. Add a **Calculate field** step named `status_label` with
   `if({{status}} == 'O', 'Open', 'Closed')`.
3. Put the derived layer on the map in place of the source layer.
4. Use `{status_label}` in the label or the popup.

The derived layer recomputes on every read, so edits to the source
show up on the next request without a refresh step.

## What has no equivalent yet

- Date functions and date arithmetic (`DateDiff`, `DateAdd`, `Now`,
  `Year`).
- Type conversion (`Number`, `Text` with format patterns). Popups in
  field list mode have their own date and number formatting.
- Text functions beyond the list above (`Replace`, `Mid`, `Split`,
  `Trim`).
- `FeatureSet` functions, which read other layers inside an
  expression. Use a spatial join or spatial filter step.
- Arcade in dashboards and data expressions. Dashboards are web
  apps, and their charts read layers and derived layers directly.
- Variables, loops and user-defined functions.
