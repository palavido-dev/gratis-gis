---
id: analysis-random-sample
title: Random sample
summary: Keep a deterministic random subset by percentage or exact count, keyed by a stable seed.
category: analysis
order: 41
complexity: basic
tags:
  - analysis
  - derived-layer
  - random-sample
related:
  - items-derived-layer
  - analysis-top-n
  - analysis-filter
---

A **random sample** step keeps a deterministic random subset of
the input. Geometry and attributes pass through. The sample is
stable across reads of the same recipe for the same source
because it hashes each feature id with a persisted **seed**
(not Postgres `random()`).

## Inputs

- **Source layer**.
- **Mode**:
  - **percentage** — keep roughly `value` percent of rows
    (greater than 0, at most 100). Actual count may vary
    slightly because each row is accepted or rejected by a hash
    threshold.
  - **count** — keep exactly `value` rows (positive integer,
    soft max 100,000).
- **Seed**. Nonzero integer stored on the recipe. Changing the
  seed reshuffles which rows are kept; the same seed repeats the
  same sample.

## Output

A subset of input rows, same schema. Order is not meaningful
except that count mode orders by the hash before applying
`LIMIT`.

## How to use it on its own
![Derived layer recipe with a Random sample step](/help/analysis/random-sample-analyze-guide.png)


1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Random sample** step.
4. Choose percentage or count, the value, and a seed.
5. Save.

## From a data layer Analyze tab

On a data layer's **Analyze** tab, **Random sample for this
layer** opens mode, value, and seed controls (with a
client-side reshuffle) and creates a private derived layer with
a single random-sample step (same PostGIS path as above). Expect
a short server job, not an instant browser result. Changing the
seed before create reshuffles which rows are kept; the saved
seed keeps the sample stable across later reads.

## Examples

- **Ten percent QA sample**. Mode: percentage. Value: 10.
  Seed: any stable integer.
- **Exactly 500 inspection sites**. Mode: count. Value: 500.

## Notes

- **Deterministic on purpose.** Re-opening the derived layer does
  not roll a new sample unless you change the seed.
- **Not stratified sampling.** There is no group-by or stratum
  control on this step.
- Pair with [Filter](analysis-filter) first when the sample should
  only come from a subset.
