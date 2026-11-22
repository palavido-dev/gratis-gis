---
id: map-editing-labels
title: Labels
seoTitle: "Label map features from field values"
summary: Render a text label per feature, computed from one or more fields, with placement and visibility controls.
category: map-editing
order: 20
complexity: basic
tags:
  - labels
  - map-editing
related:
  - symbology-simple
  - map-editing-popups
---

**Labels** render a text string per feature on the map. The
string is computed from one or more fields; placement, font, halo,
and zoom-visibility are all configurable.

## Inputs

- **A layer** on the map.
- **A label expression**. Plain text with field references in
 `{braces}`: `"{name}"`, `"{owner} ({acres} ac)"`, `"#{parcel_id}"`.
- **A font and size**.
- **A halo / outline** (optional) for legibility over busy
 basemaps.
- **A placement strategy**:
  - For points: above, below, centered, offset.
  - For lines: along the line, with curve following.
  - For polygons: centroid, pole of inaccessibility (the visual
    center for irregular shapes).
- **Visibility scale window**: minimum and maximum zoom levels
 at which labels render. Common pattern: hide at low zoom (too
 cluttered), show at street level.

## How to set it

1. Open the map in the builder.
2. In the layer list, click **Style** → **Labels** tab.
3. Toggle labels on.
4. Type the label expression.
5. Pick font, halo, placement.
6. Set the zoom window if needed.
7. Save.

## Collision avoidance

The renderer hides labels that would overlap each other. There's
no "show all labels even if overlapping" toggle today; the right
answer for that case is usually a clustered point + a popup with
the full list.

A label's **priority** field (in the label panel) breaks ties:
when two labels collide, the higher-priority one wins. Useful for
"always show the city name even if the street labels go away."

## Notes

- **Expressions are not Arcade.** Field interpolation is the
 supported syntax today. If you need conditional labels
 (`"Open"` or `"Closed"` based on a status field), compute a
 derived column on the layer and label off that.
- **Multi-line labels** use a literal newline in the expression
 or a `\n` token.
- **Halo width** is in pixels; 2px is a common starting point on
 imagery backgrounds.
