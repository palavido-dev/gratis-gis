---
id: reference-expression-language
title: Expression language
seoTitle: "Expression language for filters and calculated fields"
summary: "The expression syntax for derived-layer Filter and Calculate field steps and the attribute table's Calculate field: operators, functions, and what is not supported."
category: reference
order: 20
complexity: intermediate
tags:
  - reference
  - expressions
  - syntax
related:
  - map-editing-filters
  - analysis-filter
  - analysis-calculate
  - forms-conditional-logic
---

This page is the reference for the expressions you type into:

- The **Filter** step of a [derived layer](/help/items/derived-layer).
- The **Calculate field** step of a derived layer.
- **Calculate field** in a data layer's attribute table.

Form conditional logic has its own syntax. See
[Conditional logic](/help/forms/conditional-logic). Labels and
popups do not evaluate expressions; they fill in `{field}` values.

## Literals

- **Numbers**: `1`, `3.14`. Negative numbers use a minus sign:
  `-42`.
- **Text**: single quotes, `'open'`, `'needs repair'`. To put an
  apostrophe inside, escape it with a backslash: `'it\'s'`.
- **Booleans**: `true`, `false`.
- **Null**: `null`. See the note on empty values below.

## Field references

Field references use double braces: `{{status}}`,
`{{created_at}}`. Names are letters, digits and underscores, start
with a letter or underscore, and are case-sensitive: `{{Status}}`
does not match a field named `status`.

## Operators

| Kind | Operators | Example |
|---|---|---|
| Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=` | `{{acres}} >= 5` |
| Boolean | `AND`, `OR`, `NOT` | `{{status}} == 'open' AND NOT {{archived}}` |
| Arithmetic | `+`, `-`, `*`, `/`, `%` | `{{acres}} * 0.4047` |
| Text join | `~~` | `{{first}} ~~ ' ' ~~ {{last}}` |

- Equality is `==`. A single `=` is a syntax error.
- `AND`, `OR` and `NOT` are case-insensitive. Comparisons are
  worked out first, then `NOT`, then `AND`, then `OR`. Use
  parentheses when in doubt.
- Text joins use `~~` (or `concat`), not `||`, so `||` is never
  mistaken for "or".
- Dividing by zero, or taking `%` of zero, gives an empty value
  instead of failing the whole layer.

## Functions

Function names are case-insensitive.

| Function | Returns | Notes |
|---|---|---|
| `upper(x)`, `lower(x)` | text | Change case. |
| `length(x)` | number | Number of characters. |
| `concat(a, b, ...)` | text | Joins any number of values. |
| `coalesce(a, b, ...)` | first non-empty value | At least two arguments. |
| `abs(x)` | number | Absolute value. |
| `round(x)` | number | Rounds to a whole number. One argument only. |
| `floor(x)`, `ceil(x)` | number | Round down or up. |
| `if(condition, then, else)` | the type of `then` | Exactly three arguments. Nest for more branches. |

Examples:

- Hectares from acres: `{{acres}} * 0.4047`
- Two decimal places: `round({{ratio}} * 100) / 100`
- Full name: `concat({{first}}, ' ', {{last}})`
- Size class: `if({{acres}} > 5, 'Large', if({{acres}} > 1, 'Medium', 'Small'))`

## Types

Each field has a type from the layer's schema, and the expression
is checked before it runs:

- **Numbers** take arithmetic and compare with numbers.
- **Text** compares with text and joins with `~~` or `concat`.
  Arithmetic on text is refused.
- **Dates** are ISO 8601 text. They compare with other dates and
  with text literals, so `{{inspected}} >= '2026-01-01'` works.
  Arithmetic on a date is refused.
- **Multi-select fields** support only `==` and `!=` against a text
  value, meaning "is exactly this selection."

## Empty values

Like SQL, comparing anything with an empty value never matches.
`{{owner}} == null` is never true. To test for an empty field,
compare through `coalesce`:

- Empty: `coalesce({{owner}}, '') == ''`
- Not empty: `coalesce({{owner}}, '') != ''`

## Not supported

- **Date functions and date arithmetic.** There is no `today()`,
  `now()` or date difference in this syntax yet.
- **`case when`, `in (...)`, `like`, `between` and `is null`.** Use
  `if`, chains of `==` joined with `OR`, and the `coalesce` pattern
  above.
- **Type conversion** (`cast`).
- **Geometry functions** such as area or length. Use the
  **Calculate geometry** step. See [Calculate](/help/analysis/calculate).
- **Spatial predicates.** Use a **Clip**, **Spatial filter** or
  **Spatial join** step.
- **Arcade.** Imports from ArcGIS Online drop Arcade with a warning.
  See [Arcade to expressions](/help/coming-from-arcgis/arcade-to-expressions).
- **Subqueries and user-defined functions.** Chain derived-layer
  steps instead.

## Performance

A derived layer recomputes on every read, so a long chain of steps
over a large layer costs time on each request. Filter early in the chain to keep later steps
small.
