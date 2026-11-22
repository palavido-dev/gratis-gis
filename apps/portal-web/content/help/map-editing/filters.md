---
id: map-editing-filters
title: Filters
seoTitle: "Filter map layers by attribute without changing data"
summary: Show only the features of a layer that match a condition, without altering the underlying data.
category: map-editing
order: 30
complexity: basic
tags:
  - filter
  - map-editing
related:
  - analysis-filter
  - map-editing-popups
---

A **filter** is a per-map-layer condition that limits which
features of the underlying layer are drawn on this map. The
underlying data layer is untouched; switch to another map and
every feature is back.

Use filters to scope a map to one project area, one status, or
one time period without forking the data.

## Inputs

- **A layer** on the map.
- **A filter expression**: a Boolean combination of field
 comparisons. Examples:
  - `status = 'open'`
  - `created_at > '2026-01-01'`
  - `priority in ('high', 'critical') AND area = 'north'`
- Optional: a **viewport filter** (only draw features inside the
 current map viewport).

## How to set it

1. Open the map in the builder.
2. In the layer list, click **Filter**.
3. Use the visual filter builder (field, operator, value) or
 switch to the **Expression** tab for a freeform query.
4. Preview shows the matching count vs. total.
5. Save.

## Filter on the map vs. on the layer

- **On the map layer reference**: scopes this map only. Other
 maps see the unfiltered data layer.
- **On the data layer's default view**: applies everywhere this
 data layer is referenced. Useful when "we never want users to
 see archived records" should be the default.
- **As a derived layer**: produces a new layer item with the
 filter applied. Use when you want the filtered subset to be
 share-able as its own thing or feed downstream analysis.

## Expression syntax

The expression dialect is a SQL-like subset:

- **Comparison**: `=`, `!=`, `<`, `<=`, `>`, `>=`, `like`, `ilike`,
 `in (...)`, `between ... and ...`, `is null`, `is not null`.
- **Boolean**: `and`, `or`, `not`.
- **String literals**: single quotes (`'open'`).
- **Date literals**: ISO 8601 strings (`'2026-01-01'`).
- **Field references**: bare identifiers (`status`, `created_at`).

Spatial predicates (`ST_Intersects`, `ST_Within`) are NOT
available in this builder; for spatial filters, use a derived
layer with a Clip step.

## Notes

- **Filters compose with the layer's default view.** If the data
 layer's default view filters out archived records and this
 map's filter says `status = 'open'`, only non-archived open
 records appear.
- **Indexed fields** filter fast; unindexed fields filter slowly.
 If a filter is permanent, ask an admin to add an index to the
 field.
- **No cross-layer joins** in a filter. To filter layer A based
 on layer B, build a derived layer with a Spatial join step.
