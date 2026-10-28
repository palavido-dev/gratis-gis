---
id: analysis-filter
title: Filter
summary: Keep rows from a source layer that match a {{field}} expression. The simplest derived-layer step.
category: analysis/select-and-calculate
order: 10
complexity: basic
tags:
  - analysis
  - derived-layer
  - filter
related:
  - items-derived-layer
  - map-editing-filters
  - analysis-calculate
  - reference-expression-language
---

A **filter** step keeps the rows of a source layer that match a
Boolean expression. The output is the same schema, the same
geometry type, with fewer rows.

Expressions use the shared
[expression language](reference-expression-language): field
references need double braces (`{{status}}`), not bare SQL column
names.

Use as a building block in any pipeline (filter, then buffer;
filter, then group-by; filter, then spatial-join). Use alone when
you want a permanently-filtered subset as its own item.

## Inputs

- **Source layer**: any data layer or derived layer the pipeline
  can read.
- **Expression**: a non-empty Boolean expression in the shared
  dialect (max 2000 characters). Example:
  `{{status}} = 'needs-repair'`. See
  [Expression language](reference-expression-language).

## Output

A new layer whose rows are those of the source for which the
expression evaluates true. Schema and geometry are identical to
the source. Geometry passes through unchanged.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Filter** step.
4. Type the expression with `{{field}}` refs.
5. Save.

## Example

You have a fire-hydrant layer with thousands of features. You
want a published layer of only the hydrants flagged as
"needs-repair". One Filter step with expression
`{{status}} = 'needs-repair'` produces it. Share the derived
layer with the maintenance crew; they always see the current
backlog.

## Filter step vs. map filter

If the only consumer is one map, set the filter on the map's
layer reference instead (same `{{field}}` dialect). A derived
layer materializes its rows into its own table; a map filter is
a query-time scoping clause. The derived layer is the right
choice when you want the subset itself to be a shareable, named,
citable item.

## Notes

- **Brace field names.** `status = 'open'` is not valid here;
  write `{{status}} = 'open'`. Bare names fail validate.
- **Indexed fields filter fast.** If a filter is permanent and
  the source layer has many features, ask an admin to add an
  index on the field.
- **NULL handling**: `{{field}} is null` and
  `{{field}} is not null` are explicit. `{{field}} = null` is
  always false, like SQL.
- **Not Calculate.** Filter only keeps or drops rows. To add a
  computed column, use [Calculate](analysis-calculate).
