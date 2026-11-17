---
id: symbology-simple
title: Simple symbology
summary: Render every feature of a layer with the same fill, stroke, and size. The default and the right starting point.
category: map-editing/symbology
order: 10
complexity: basic
tags:
  - symbology
  - simple
related:
  - symbology-categorical
  - symbology-graduated
  - symbology-scale-classes
---
![Map builder layer style panel for Trails](/help/map-editing/symbology/simple-symbology-panel.png)

**Simple symbology** is the default and the right choice when you
want every feature of a layer drawn the same way. One stroke
color, one fill, one icon if it's a point layer. No conditional
logic, no class breaks. The layer is a uniform set of features
on the map.

## Inputs

- **A layer** (data layer reference, derived layer, or ArcGIS
 service) on the map.
- **A fill** for areas and points. Color, opacity.
- **A stroke** for lines and polygon outlines. Color, width,
 opacity, dash pattern.
- **An icon** for point layers (optional). A built-in icon, an
 uploaded image, or a Maki-style sprite.
- **A size** for points (radius) or lines (width).

## How to set it

1. Open the map in the builder.
2. In the layer list, click the layer's **Style** action.
3. Pick **Simple** as the symbology mode (it's the default).
4. Adjust the fill, stroke, and size pickers.
5. **Save** the map.

That's it. No expressions, no class lists.

## When to step up

Move to **Categorical** when different feature values should look
different (e.g., status of an inspection). Move to **Graduated**
when a numeric value should drive size or color (e.g., parcel
acreage). Move to **Scale classes** when the same layer should
look different at different zoom levels.

## Notes

- **Stroke width is in pixels.** Constant on screen, not on the
 ground. For ground-distance stroke (a 1-meter buffer rendered
 as a thick line), use a small derived buffer layer instead.
- **Opacity stacks.** A stroke at 50% opacity over a fill at 50%
 opacity is the natural blend; don't try to compensate with
 brighter fills.
