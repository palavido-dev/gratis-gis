---
id: creating-your-first-map
title: Creating your first map
summary: Start a new map item, add a layer, save.  The single shortest path from "I just signed in" to "I have a map I can share."
category: getting-started
order: 20
complexity: basic
prerequisites:
  - what-is-gratisgis
related:
  - items-map
  - sharing-an-item
  - adding-a-layer
---

A **map** is an item that combines one or more layers with a
viewport and a basemap. Maps are how you compose data for human
consumption; they're what web apps render and what print templates
print.

![New item wizard after choosing Map, with title, visibility, and Create item](/help/getting-started/creating-your-first-map-new-item.png)

## Steps

1. From the items grid (the landing page after you sign in), click
 **+ New item**.
2. Pick **Map** from the wizard (under the Maps category). Fill in
 a title and visibility, then click **Create item**.
3. You land on the map's detail page. Click **Open map** (or open
 it with **view=configure**) to enter the map surface.
4. In the map builder, use the **Layers** rail on the left to manage
 overlays. Add layers from items you can read.
5. The layer renders on the map. Open style controls on the layer to
 change its color, size, and labels. Save with **⌘S** or the
 Save button.

![Map builder with a Layers rail, the map canvas, and Map settings](/help/getting-started/creating-your-first-map-builder.png)

On a phone the layer list and the settings panel collapse to
icons at the edges of the map. Tap an icon to slide that panel
over the map, then tap the map to put it away.

That's it. You now have a map you can share, embed in a web app,
or print.

## What you do next depends on the use

- **Style the layer**: select it in the layer panel and use the
 Style + Symbology controls. See **Map editing → Symbology**.
- **Constrain what users see**: add a filter on the layer
 (**Filters** section).
- **Decide what happens on click**: configure popups (**Popups**
 section).
- **Share it**: the **Sharing** section on the map's detail page.

## What the map item stores

The map item's `data` blob includes:

- The list of layers (each with its style, filter, popup config).
- The default viewport (center, zoom, bearing, pitch).
- The basemap binding.
- Per-layer access overrides (separate from the underlying data
 layer's own sharing).

It does *not* duplicate the features themselves. Those live in the
referenced data layer items. A change in the underlying data
layer shows up immediately on every map that references it.
