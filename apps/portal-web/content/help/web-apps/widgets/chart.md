---
id: widget-chart
title: Chart widget
summary: Render a bar, line, or pie chart bound to a layer or derived layer. Updates live as the map filters.
category: web-apps/widgets
order: 80
complexity: intermediate
controls:
  - id: widget-chart-toggle
    label: "Chart tile in the widget palette"
tags:
  - widget
  - chart
  - data-viz
related:
  - widget-filter
  - items-web-app
  - items-derived-layer
  - items-dashboard
---

The **Chart** widget renders a chart inside a Custom Web App,
bound to a layer or derived layer's data. Use to surface a
small data viz alongside the map: incident counts per month, a
status distribution, an average over time.

## What it can render

- **Bar chart** (vertical or horizontal). Discrete categories
 along one axis, a numeric metric along the other.
- **Pie / donut chart**. Share of total per category. Best for
 small category counts.
- **Line chart**. A metric over an ordered axis (typically
 time).
- **Number indicator** (single big number with optional trend).
 Use for a one-off "X total" readout, not a comparison.

## Inputs

- **Bound layer**. A data layer, derived layer, or ArcGIS
 service.
- **Category field** (bar / pie / line). The discrete groups.
 For line charts, the x-axis field (a date or ordered numeric).
- **Value field** (bar / line). The numeric metric per
 category.
- **Aggregation**: `count(*)`, `sum`, `avg`, `min`, `max`.
- **Sort**: by category (alphabetical), by value (descending or
 ascending), or custom.
- **Limit**: top N categories shown; the rest grouped as
 "Other" (optional).

## Live filtering

The chart re-queries on map filter change. Filtering the bound
layer (via layer-list, filter widget, or a category click on
this same chart) updates the data. This is the cross-widget
filter pattern: clicking a bar can drill into "only that
category" elsewhere.

## Widget config

- **Chart type**: bar / pie / line / number.
- **Bound layer and fields** (as above).
- **Title** (optional).
- **Color palette**: built-in palettes, or define per-category
 colors that match the layer's symbology (the "match
 symbology" toggle).
- **Refresh interval** (default: on map filter change; can
 also poll every N seconds).

## Notes

- **Big aggregates are slow.** A bar chart binning a million
 features per category over an unindexed field can take
 seconds. Build a pre-aggregated derived layer for hot
 dashboards.
- **For a screen-filling dashboard**, use the **Dashboard**
 item type, not a Custom Web App with a chart widget. Charts
 in apps are best as one-or-two-widget accents alongside a
 map.
