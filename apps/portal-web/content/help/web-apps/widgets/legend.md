---
id: widget-legend
title: Legend widget
seoTitle: "Legend widget for web map apps"
summary: Render the visible layers' symbology as a labeled list. The thing viewers use to understand what colors mean.
category: web-apps/widgets
order: 60
complexity: basic
controls:
  - id: widget-legend-toggle
    label: "Legend tile in the widget palette"
tags:
  - widget
  - legend
related:
  - items-web-app
  - symbology-simple
---

The **Legend** widget renders the visible layers' symbology as a
labeled list. For simple symbology, one swatch per layer; for
categorical, one swatch per class; for graduated, a color ramp
with break labels.

## What it shows

Each visible layer contributes a section:

- **Layer name** as a section header.
- **One row per class** with a swatch and a label.
- For graduated, a **color ramp** with min / max value labels.
- For continuous-by-size graduation, a **size legend** (small
 dot, medium dot, large dot, labeled).

Layers hidden via the layer list toggle are excluded; turning a
layer off updates the legend.

## Widget config

- **Position**. Floating (default) or docked.
- **Title text** (optional; default: "Legend").
- **Show layer headers** (default: on). Off for single-layer
 maps where the layer name is obvious.
- **Group classes** (default: off). When on, similar classes
 across layers are grouped; for most maps, off is more
 readable.

## Notes

- **Stays in sync with the style.** When the map style updates
 (an admin changes a layer's symbology), the legend reflects
 it on the viewer's next page load.
- **The legend isn't editable from the widget.** Edit
 symbology in the map builder; the legend renders what the
 builder has set.
