---
id: widget-attribute-table
title: Attribute table widget
summary: A bottom panel that shows feature rows in a sortable, filterable table tied to one or more map layers.
category: web-apps/widgets
order: 40
complexity: basic
controls:
  - id: widget-attribute-table-toggle
    label: "Attribute Table tile in the widget palette"
tags:
  - widget
  - attribute-table
  - features
related:
  - items-web-app
  - items-data-layer
---

The **Attribute table** widget is a slide-up table at the bottom
of the map that displays rows from one or more layers. Use for
"I need to see the data behind the dots."

## What it shows

A table with one row per feature. Columns are the layer's
fields (configurable). Selecting a row in the table highlights
the feature on the map; clicking a feature on the map
highlights its row.

A layer dropdown in the table header switches between configured
layers (one layer's table at a time).

## Default behavior

- Sortable by clicking column headers.
- Filterable by typing a string in the per-column filter row.
- The current map view's filter applies to the table (when
 the layer is filtered on the map, the table shows the matching
 rows only).
- Selecting a row zooms to its feature.

## Bulk actions

For users with edit access to the layer:

- **Edit** a single row's attributes (inline editing in the
 table cell).
- **Delete** selected rows.
- **Export selected** to CSV / XLSX.

## Widget config

- **Bound layers**. One or more; the table dropdown picks among
 them.
- **Visible columns** per layer. Default: all fields except
 internal ones (id, created_at, edited_at). Add/remove and
 reorder.
- **Default page size**. 50 by default; up to 1000.
- **Allow editing** (default: yes if the viewer has edit access,
 no otherwise).
- **Allow bulk-export** (default: yes).
- **Open by default** (default: closed; user opens via a
 widget button).

## Performance

The table queries features lazily: only the rows visible in the
table are fetched, plus a small look-ahead. Scrolling fast or
sorting on an unindexed field can produce a brief loading state.

## Notes

- **No cross-layer joins** in the table view. Use a derived
 layer if you need a combined view.
- **Geometry isn't shown** in the table cell. The map handles
 geometry rendering; the table shows attributes.
- **Read-only on derived layers.** Derived layers are live
 recipes; editing a derived row is not supported and would not
 write back to the source. The table reflects this by hiding
 the edit affordance on derived-layer rows.
