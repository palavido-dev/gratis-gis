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

GratisGIS does not run Arcade, but its expression language covers
most of what Arcade expressions do, and accepts many Arcade
spellings as they are. Web map imports from ArcGIS Online drop Arcade
expressions with a warning. Labels and popups take plain
field references such as `{name}`, and do not evaluate expressions.
Computed values come from the **Filter** and **Calculate field**
steps on a [derived layer](/help/items/derived-layer), which use a
small expression language of their own.

This page translates common Arcade patterns.

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

- Fields: `{{status}}`, or Arcade's `$feature.status`. Names are
  case-sensitive.
- Text: single or double quotes.
- Compare with `==` or `=`, `!=` or `<>`, `<`, `<=`, `>`, `>=`.
- Combine with `AND` or `&&`, `OR` or `||`, `NOT` or `!`.
- `IN`, `BETWEEN`, `LIKE`, `IS NULL` and `CASE WHEN` work as in SQL.
- `+` adds numbers and joins text, as in Arcade.
- Dates have functions for adding, differencing, extracting and
  formatting.

The full list is in the
[expression language reference](/help/reference/expression-language).

## Translating common patterns

Many Arcade function names work as they are: `IIf`, `When`,
`Decode`, `DefaultValue`, `IsEmpty`, `Mid`, `Find`, `Concatenate`,
`DateAdd`, `DateDiff`, `Constrain`, `Upper`, `Lower`, `Round`.

| Arcade | GratisGIS expression |
|---|---|
| `$feature.status` | `$feature.status` or `{{status}}` |
| `$feature.a == 1 && $feature.b != 'x'` | the same |
| `IIf($feature.acres > 5, 'Large', 'Small')` | the same, or `if({{acres}} > 5, 'Large', 'Small')` |
| `When($feature.p == 1, 'High', $feature.p == 2, 'Medium', 'Low')` | the same |
| `Decode($feature.code, 'A', 'Active', 'Other')` | the same |
| `Concatenate([$feature.first, ' ', $feature.last])` | `concat({{first}}, ' ', {{last}})` |
| `Count($feature.name)` (text length) | `length({{name}})` |
| `IsEmpty($feature.owner)` | the same, or `{{owner}} IS NULL` |
| `Round($feature.value, 2)` | the same |
| `Text($feature.value, '#,###.00')` | `format_number({{value}}, 2)` |
| `Text($feature.d, 'MMM D, Y')` | `format_date({{d}}, 'MMM D, YYYY')` |
| `Number($feature.code)` | the same |
| `Now()`, `Today()` | the same |
| `DateDiff(Now(), $feature.d, 'days')` | the same |
| `DateAdd($feature.d, 30, 'days')` | the same |
| `Year($feature.d)` | the same |
| `Month($feature.d)` | `month({{d}})`, which counts 1 to 12. Arcade counts 0 to 11. |
| `Weekday($feature.d)` | `weekday({{d}})`, which is Monday 1 to Sunday 7. Arcade is Sunday 0 to Saturday 6. |
| `Replace`, `Trim`, `Left`, `Right`, `Proper` | the same |
| `Split($feature.s, ',')[1]` | `split_part({{s}}, ',', 2)`, counting from 1 |
| `Area($feature, 'acres')` | `area($feature, 'acres')` |
| `Length($feature, 'feet')` | `length($feature, 'feet')` |

Notes:

- **Counting from 1.** Positions in `substr`, `index_of` and
  `split_part` count from 1, as in SQL. Arcade counts from 0.
- **Empty values.** `{{owner}} == null` is true for an empty owner,
  as in Arcade.

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

- Variables, loops and user-defined functions.
- Regular expressions.
- Arcade in dashboards and data expressions. Dashboards are web
  apps, and their charts read layers and derived layers directly.
