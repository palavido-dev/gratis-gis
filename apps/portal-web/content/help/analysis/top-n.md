---
id: analysis-top-n
title: Top N
summary: Keep the N rows with the highest or lowest numeric attribute value. Geometry and attributes pass through.
category: analysis
order: 40
complexity: basic
tags:
  - analysis
  - derived-layer
  - top-n
related:
  - items-derived-layer
  - analysis-random-sample
  - analysis-nearest-neighbor
  - analysis-calculate
---

A **top-n** step keeps the N input rows with the highest or lowest
value of a **numeric** attribute. Geometry and other attributes
pass through unchanged.

Useful for "ten largest parcels" or "five smallest
`nearest_distance_m`" after a
[Nearest neighbor](analysis-nearest-neighbor) or
[Calculate geometry](analysis-calculate) step.

## Inputs

- **Source layer**.
- **Field**. Must exist on the source schema and be type
  **number** at save time.
- **N**. Positive integer, at least 1, soft max 100,000 (the
  recipe `featureLimit` may still cap the materialized output).
- **Direction**. `desc` (highest first, default) or `asc`
  (lowest first).

## Output

Up to N rows, same schema as the source. Non-numeric or missing
values for the sort field are pushed to the end (`NULLS LAST`)
and typically fall outside the top N.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Top N** step.
4. Choose the numeric field, N, and direction.
5. Save.

## Examples

- **Ten largest parcels**. Field: `acres`. N: 10. Direction:
  desc.
- **Five closest neighbors**. After nearest-neighbor, field:
  `nearest_distance_m`. N: 5. Direction: asc.

## Notes

- **Numeric field only.** String or date fields are rejected at
  validate.
- **Not a second-layer join.** Ranking is within the pipeline
  input only.
