---
id: widget-export
title: Export widget
seoTitle: "Export widget: download features as CSV or Excel"
summary: Toolbar tool that downloads the visible features of the bound map as CSV or Excel.
category: web-apps/widgets
order: 30
complexity: basic
controls:
  - id: widget-export-toggle
    label: "Export tile in the widget palette"
tags:
  - widget
  - export
related:
  - widget-print
  - bundle-export
  - web-apps-custom-app
---

The **Export widget** is the toolbar twin of the Print widget. It
binds to a Map widget and offers a popover with format + scope
controls. Click Export → pick a format → the browser downloads.

## How to add one

1. Open your Custom Web App in the builder.
2. From the **Map** group in the left palette, drag **Export** onto
 the canvas (it ships in tool-display mode by default).
3. Drop it into your Container (app-bar, dock panel, etc.) next to
 Print.
4. In the right rail, set **Map** to the Map widget this Export
 should pull features from.

## What it exports

The widget pulls features from the bound map's live MapLibre source
via `querySourceFeatures`. That means **"visible features"
means whatever tiles are currently loaded** around the user's
viewport. The same set the popups and the layer list see.

For a guaranteed-complete dump of a layer, including features
outside the current viewport, use the **Bundle export** from the
data layer's detail page or the attribute table.

## Options

| Option | What it does |
|---|---|
| **Map** | Which map widget to pull features from. |
| **Default layer** | Optional default target (first layer if omitted). |
| **Default format** | XLSX (default) or CSV. |

## At runtime

The widget renders as an icon button. Clicking it opens a small
popover with:

- **Layer** dropdown (every target layer on the bound map).
- **Format** toggle (Excel / CSV).
- **Export visible**. Every feature currently loaded.
- **Export selection**. Features the user has selected on the
 bound map.

XLSX exports include a `geometry_wkt` column so the user can
round-trip the geometry into desktop GIS. CSV stays text-only by
convention.

## When to use Bundle export instead

If the user needs:

- Every feature in the layer, not just the visible ones
- Related-table sheets in the same workbook
- Feature attachments (photos, etc.)

... use the Bundle export from the data layer's detail page or the
attribute table's Export menu. The Export widget is the quick
"give me what's on screen" tool.
