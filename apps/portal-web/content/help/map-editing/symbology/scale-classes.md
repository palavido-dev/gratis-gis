---
id: symbology-scale-classes
title: Scale classes
seoTitle: "Scale-dependent styling: change style by zoom level"
summary: Render one layer with different colors at different zoom levels without forking it into two layers.
category: map-editing/symbology
order: 40
complexity: intermediate
controls:
  - id: scaled-symbology-add-button
    label: "+ Add class"
prerequisites:
  - symbology-simple
tags:
  - symbology
  - zoom
  - scale
related:
  - symbology-simple
---

A **scale class** is a symbology override scoped to a zoom range.
A layer that has one or more scale classes paints with the class's
style when the map is at that zoom; outside any class, it falls
back to the layer's base style.

The point is that the layer's popups, filters, labels, search, and
sharing all stay singular. You're not duplicating the layer. You
just want it to look different up close.

<!-- screenshot: layer panel "Scale classes" section with one class added, showing the min/max zoom inputs and the per-class color rows -->
## How to add one

1. Open a map and select a layer in the layer panel.
2. Scroll to **Style → Scale classes** (under the regular Style
 editor).
3. Click **+ Add class**.
4. Set the **Min zoom** and **Max zoom** for the range you want
 this class to cover. Leave either blank for "no bound."
5. Set the colors for the geometry types the layer has.
6. Save the map.

The change takes effect immediately. Zoom in and out across your
threshold; the layer's color switches at the zoom you set.

## Range semantics

- **Min zoom is inclusive.** A class with min=10 takes effect at
 zoom 10 and above.
- **Max zoom is exclusive.** A class with max=14 stops applying
 at zoom 14.
- **Gaps fall back to the base style.** A class covers [10, 14)
 and another covers [16, 22); zoom 14 and 15 paint with the
 layer's base style.
- **Overlaps are undefined in v1.** Keep ranges non-overlapping.

## Example: dim a polygon's fill at high zoom

You have a counties layer. At low zoom you want the fill
semi-transparent so users see the basemap through it. At high
zoom (parcel-level) you only want the outline so the fill doesn't
hide individual parcels.

1. Set the **base style** with fill color `rgba(99,102,241,0.4)`.
 This is what shows at low zoom.
2. Add a scale class. Set **Min zoom = 14**.
3. Set the class's fill color to `rgba(99,102,241,0)` (zero alpha
 = invisible fill).
4. Set the class's stroke color the same as the base.

Pan and zoom: below z14 you see the translucent fill; at z14 and
above the fill disappears but the outline stays.

## What works in v1

- **Colors** for polygon fill, polygon stroke, line, and point.

## What doesn't work yet

- **Width, opacity, and radius**. Those still come from the
 layer's base style regardless of the active class. As a
 workaround, use the alpha channel of an `rgba()` color to vary
 apparent transparency (as in the example above).
- **Renderer overrides per class**. A class with `renderer:
 unique-values` is stored but not consulted at runtime; the base
 layer's renderer applies.

Both items are tracked as follow-ups.
