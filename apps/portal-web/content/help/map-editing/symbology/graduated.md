---
id: symbology-graduated
title: Graduated symbology
seoTitle: "Graduated colors and sizes: class breaks and color ramps"
summary: Drive a feature's color (or size) by a numeric field, using class breaks or a continuous ramp.
category: map-editing/symbology
order: 30
complexity: intermediate
tags:
  - symbology
  - graduated
  - class-breaks
related:
  - symbology-simple
  - symbology-categorical
---

**Graduated symbology** binds a feature's color and / or size to
the value of a numeric field. Use for parcel acreage, incident
count, household income, anything where a numeric magnitude
should map visually onto the feature.

Two flavors:

- **Class breaks.** Define N break values; each range gets its
 own fill color (or size). The map renders as a step-graded
 choropleth.
- **Continuous ramp.** A min and max color; every feature's color
 is interpolated along the ramp by its value.

## Inputs

- **A layer** on the map.
- **A numeric field** (integer, decimal, computed numeric).
- A **classification method** (class-breaks mode):
  - **Quantile** (equal feature count per class).
  - **Equal interval** (equal value range per class).
  - **Natural breaks (Jenks)** (groupings that minimize within-
    class variance).
  - **Manual** (pick the break values yourself).
- A **color ramp** (one of the built-ins, or a custom min→max
 pair).
- Optional **size graduation**: small radius at low value, large
 at high, for point layers.

## How to set it

1. In the map builder's layer style panel, pick **Graduated**.
2. Pick the **field**.
3. Pick **Class breaks** or **Continuous**.
4. For class breaks, choose method and class count. Adjust the
 break values if needed.
5. Pick a color ramp.
6. Save.

## When to pick class breaks vs. continuous

- **Class breaks** when the audience wants legible categories
 ("low / medium / high"). Easier to read on a paper legend.
- **Continuous** when the magnitude matters and the audience can
 reference a color bar. Looks smoother; harder to read off the
 exact value.

## Notes

- **Outliers wreck equal-interval.** One feature with a value
 10x larger than the rest collapses the legend. Quantile or
 Jenks handles this better.
- **Diverging vs. sequential ramps.** Use a sequential ramp
 (one color darkening) for "more of one thing." Use a diverging
 ramp (two colors meeting at a midpoint) for "difference from a
 reference value" (positive vs. negative growth, for example).
- **NULL is excluded.** Features with NULL in the chosen field
 are drawn with the fallback symbol (set in the style panel) or
 hidden. They're never classed alongside numeric values.
