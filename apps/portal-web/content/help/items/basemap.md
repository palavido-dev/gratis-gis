---
id: items-basemap
title: Basemap
summary: An item that wraps a single base-layer reference (style URL, tile URL, WMS, or a portal map). Maps pick one.
category: items/data
order: 110
complexity: basic
tags:
  - basemap
  - item-type
related:
  - items-map
  - items-tile-layer
---

A **basemap** is an item whose body is one reference to a base
layer source. It's the bottom layer every map renders against.
Streets, satellite imagery, a topographic style, your own tile
cache. Maps pick exactly one basemap per item, and the optional
basemap-gallery widget lets viewers switch between others at run
time.

## Basemap sources

A basemap's body is a discriminated union over four source kinds:

- **Style URL**. A MapLibre / Mapbox-GL style JSON. The basemap
 renders that style verbatim. Most public providers (MapTiler,
 Stadia, OpenFreeMap) expose a style URL.
- **Tile URL**. An XYZ tile template (`https://.../{z}/{x}/{y}.png`).
 The basemap wraps this as a raster source. Use for tile
 services that don't publish a style.
- **WMS**. A WMS GetMap endpoint plus layer name(s). The basemap
 renders WMS as a raster source.
- **Portal map**. A reference to another map item, rendered as
 tiles served by the portal. Lets you compose a curated basemap
 (parcels + your custom imagery + a labels overlay) and reuse it
 across many top-level maps.

## Where basemaps are picked

- The **map builder** has a Basemap selector that lists every
 basemap the user can read.
- The **org default** is a single basemap item the admin pins as
 the fallback for new maps.
- The **basemap-gallery widget** on a web app or dashboard exposes
 a basemap shortlist to end users.

## Attribution

Every basemap can carry an **attribution** string surfaced in the
bottom-right corner of every map that uses it. Most public
providers require this. The portal won't silently drop it.

## Sharing

Standard three-tier. A public basemap can be referenced from
public maps; an org-only basemap restricts the maps that use it.

## Notes

- **Multiple basemap stacks** aren't supported on a single map.
 If you need "imagery PLUS a labels overlay PLUS your parcel
 outline as the bottom layer," compose those as a portal-map
 basemap.
- **Provider keys** belong in the org-level basemap settings, not
 in the URL. The portal substitutes the key at render time so it
 doesn't leak into the client.

## See also

- **Tile layer**. The portal-owned raster/vector tile container
 (PMTiles) that a tile-URL basemap can point to.
