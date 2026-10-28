---
id: reference-expression-language
title: Expression language
summary: The SQL-like dialect used across filters, calculate steps, conditional visibility, and template tokens. One vocabulary, many surfaces.
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

GratisGIS uses one expression dialect across several surfaces:

- **Map layer filters** ("show only features where...").
- **Derived layer Filter step** (the same condition, applied to
 the materialized output).
- **Derived layer Calculate step** (compute a new column).
- **Form conditional visibility** ("show this question if...").
- **Report template tokens** (Boolean conditionals inside the
 body).

Same syntax everywhere. This page is the reference.

## Literals

- **Numbers**: `1`, `3.14`, `-42`.
- **Strings**: single quotes, `'open'`, `'needs repair'`. To
 embed a quote: `'it''s'`.
- **Dates**: ISO 8601 strings, `'2026-01-01'`.
- **Datetimes**: `'2026-01-01T10:30:00Z'`.
- **Booleans**: `true`, `false`.
- **NULL**: `null`.

## Field references

Field references use double braces: `{{status}}`,
`{{created_at}}`. Names must match the schema allowlist
(letters, digits, underscore).

## Operators

### Comparison

`=`, `!=`, `<`, `<=`, `>`, `>=`.

`like`, `ilike`. String matching with `%` wildcard
(`name like 'A%'`).

`in (...)`. Membership (`priority in ('high', 'critical')`).

`between ... and ...`. Range, inclusive
(`acres between 0 and 5`).

`is null`, `is not null`, NULL checks. `x = null` is always
false, like SQL.

### Boolean

`and`, `or`, `not`. Standard precedence: `not` binds tightest,
then `and`, then `or`. Parenthesize when in doubt.

### Arithmetic

`+`, `-`, `*`, `/`, `%`. Integer / decimal handled like SQL.
NULL propagates: `1 + null = null`.

### String

`||` concatenation: `first || ' ' || last`.

## Conditional

```
case when <cond> then <val>
     when <cond> then <val>
     else <val>
end
```

Returns the first matching branch's value, or the `else` if none
match. Use for "label by status," "tier by acreage."

## Functions

### String

- `upper(x)` / `lower(x)`: case conversion.
- `length(x)`: character count.
- `trim(x)` / `ltrim(x)` / `rtrim(x)`: whitespace trim.
- `substring(x, start, len)`: substring (1-indexed start).
- `replace(x, find, repl)`: string replace.

### Numeric

- `round(x, n)`: round to `n` decimals.
- `floor(x)`, `ceil(x)`.
- `abs(x)`.

### Date

- `today()`, `now()`.
- `year(x)`, `month(x)`, `day(x)`.
- `date_diff(x, y, 'days')`: difference in days (or `'months'`,
 `'years'`, `'hours'`).
- `date_add(x, n, 'days')`: add a duration.

### Null handling

- `coalesce(x, y, z, ...)`: first non-NULL value.
- `nullif(x, y)`: NULL if `x = y`, else `x`. Useful for
 "treat empty string as missing": `nullif(name, '')`.

### Type

- `cast(x as integer)` / `cast(x as decimal)` /
 `cast(x as text)` / `cast(x as date)`.

## What's NOT in the dialect

- **Geometry helpers** (`area_m2()`, `length_m()`,
  `centroid_x()`, `bbox_*`, …). Those are not expression
  functions. Use the derived-layer **Calculate geometry** step
  (measurement length / perimeter / area + unit + field name).
  See [Calculate](analysis-calculate).
- **Spatial predicates** (`ST_Intersects`, `ST_Within`). Use a
 derived layer with a Clip or Spatial join step.
- **Arcade expressions.** Imports from AGO drop Arcade with a
 warning; rewrite using this dialect.
- **Custom functions defined by users.** Not in v1.
- **Subqueries.** Express as a derived layer instead.

## Notes

- **Identifiers are case-sensitive.** A field named `Status`
 won't match `status`. The schema editor preserves case.
- **NULL-safety**: most arithmetic, comparison, and string ops
 return NULL on NULL input. Use `coalesce` to defend.
- **Performance**: filter expressions on indexed fields run
 fast. Asking for `like '%foo%'` (wildcard at the start) bypasses
 the index; ask an admin to add a trigram index if the pattern
 is permanent.
