---
id: items-map
title: Map
summary: An item that composes layers, a viewport, and a basemap.  Maps are what web apps render and what print templates print against.
category: items
order: 10
complexity: basic
tags:
  - map
  - item-type
related:
  - items-data-layer
  - creating-your-first-map
  - adding-a-layer
  - symbology-simple
---

A **map** item is the standard way to combine layers, a basemap,
and a default viewport into something a person (or a web app) can
look at.

## What's in a map

- **Layers**. References to data layer items (or external services
 like ArcGIS-REST / WMS / tile-layer). Each reference carries its
 own style, filter, popup config, and per-layer access.
- **Basemap**. A single basemap item, optionally overridable per
 viewer through a basemap-gallery widget.
- **Viewport**. Center, zoom, bearing, pitch; the default view a
 user sees when they open the map.
- **Geocoders**. Optional list of geocoder items that drive the
 search bar.

The map does NOT store features themselves. Those live in the
referenced data layer items. Edits to the underlying data layer
appear immediately on every map that references it.

## Two surfaces

The map item has two views:

- **Detail page**. Metadata (title, description, thumbnail,
 sharing, tags) and a small preview. This is the public-facing
 card.
- **Builder**. The full editor (click **Open builder** on the
 detail page or use `?view=configure`). Map canvas in the middle,
 layers on the left, map settings on the right.

On a phone the builder keeps the map full width and tucks the
side panels behind icon rails. Search stretches across the top.
The legend, markup, and comments panels use the screen width
instead of a fixed desktop card. The attribute table docks to
the bottom and its toolbar wraps.

## Sharing

Maps follow the standard three-tier sharing (Owner only,
Organization, Public). See **Sharing an item**.

When you share a map, dependencies aren't automatically shared. If
the map references a data layer at Owner-only, viewers who can
read the map still won't see that layer. The dependency panel on
the map's detail page surfaces this with a yellow warning.

## Per-layer access

Each layer on the map has its own access rule beyond the underlying
data layer's tier. By default a layer **inherits** its item's
sharing. Whoever can read the data layer can read it on this map.
You can switch a layer to **custom** access to:

- Hide a sensitive layer from specific viewers while keeping the
 map shared widely.
- Give a single user query access to a layer even though the
 underlying item is Owner-only.

Custom access can SUBTRACT but never ADD permission. A user who
can't read the underlying data layer can't read it through this
map either, regardless of what the per-layer rule says.
