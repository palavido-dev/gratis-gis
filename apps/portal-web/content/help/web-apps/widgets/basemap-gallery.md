---
id: widget-basemap-gallery
title: Basemap gallery widget
seoTitle: "Basemap gallery widget: switch basemaps"
summary: Let viewers switch the map's basemap from a curated list. Streets, imagery, topographic, your custom basemap.
category: web-apps/widgets
order: 50
complexity: basic
controls:
  - id: widget-basemap-gallery-toggle
    label: "Basemaps tile in the widget palette"
tags:
  - widget
  - basemap-gallery
  - basemap
related:
  - items-basemap
  - items-web-app
---

The **Basemap gallery** widget lets a viewer switch the active
basemap from a curated list. Use when the audience benefits from
choosing (imagery vs. streets) but you want to limit the options.

## What it shows

A panel of basemap thumbnails. Each thumbnail is a configured
basemap item. The current basemap is highlighted; clicking a
different thumbnail swaps the basemap on the map view.

## Configuring

In widget config:

- **Basemaps**: pick a list of basemap items from this org's
 catalog. They appear in the gallery in the order set here.
- **Show thumbnails** (default: on). When off, the gallery
 renders as a text-only dropdown.
- **Allow viewer to add basemaps** (default: off). When on, a
 "+" button lets the viewer paste a tile URL or style URL to
 add an ephemeral session basemap (not saved to the org).

## Default basemap

The map's own default basemap is always in the gallery. Even if
you don't list it explicitly in widget config, the runtime
inserts it so the viewer can return to the original view.

## Notes

- **Switching basemap is per-session.** The next viewer opens
 the map with the original basemap; user choice doesn't
 persist server-side. The browser remembers per-user.
- **Sharing affects availability.** A basemap item set to
 Owner-only won't appear in the gallery for org or public
 viewers. Set the basemaps you reference to at least the
 same sharing tier as the web app.
