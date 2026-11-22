---
id: widget-layer-list
title: Layer list widget
seoTitle: "Layer list widget: toggle layers and opacity"
summary: A panel that lists the map's layers with toggle-on / toggle-off, opacity, and per-layer actions.
category: web-apps/widgets
order: 10
complexity: basic
controls:
  - id: widget-layer-list-toggle
    label: "Layers tile in the widget palette"
tags:
  - widget
  - layer-list
  - map
related:
  - items-web-app
  - items-map
---

The **Layer list** widget renders the map's layers as a panel,
each row with a visibility toggle, an opacity slider, and a
per-layer menu (zoom-to, legend, attribute table). It's the most
common widget on a Custom Web App; users expect it.

## What it shows

Each map layer is one row:

- **Visibility toggle**. Show / hide the layer in the map view.
- **Layer name and icon**. The display name from the layer's
 item; the icon distinguishes layer type (point, line, polygon,
 raster).
- **Opacity slider** (optional, off by default; turn on in
 widget config).
- **Per-layer menu**:
  - **Zoom to**: fits the map view to the layer's extent.
  - **Show legend**: expands the layer's symbology rows.
  - **Open attribute table**: routes to the attribute table
    widget (if also enabled).
  - **Open in catalog**: opens the layer's detail page in a
    new tab.

## Grouping

Layers can be **grouped** in the layer list, with a parent name
and collapsible children. Configure groups in widget config →
**Groups**. Common pattern: group operational layers under
"Live data" and reference layers under "Reference."

Layers in groups are still individual layer references; the
group is a visual rollup.

## Sort and order

The layer list reflects the map's render order by default (top
of the list = top of the map stack). Configure to:

- Show in **render order** (default).
- Show in **alphabetical** order.
- **Pin** specific layers to the top regardless of render
 order.

## Widget config

- **Show opacity slider** (default: off).
- **Show per-layer menu** (default: on).
- **Allow drag-to-reorder** (default: off; experimental).
- **Initially expanded groups** (default: all).
- **Search box** (default: off; useful for maps with 20+
 layers).

## Notes

- **The widget respects per-layer access.** Layers the viewer
 can't see don't appear in the list.
- **Visibility is session-scoped.** Toggling a layer off
 doesn't save to the map; the next viewer opens with the
 map's default visibility. Use a derived layer or the map's
 default visibility for permanent hide.
