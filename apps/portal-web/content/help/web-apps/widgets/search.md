---
id: widget-search
title: Search widget
summary: A search bar that finds locations (via a geocoder) and / or features (via field-text search).
category: web-apps/widgets
order: 20
complexity: basic
controls:
  - id: widget-search-toggle
    label: "Search tile in the widget palette"
tags:
  - widget
  - search
  - geocoder
related:
  - items-web-app
  - admin-geocoders
---

The **Search** widget renders a search bar that queries one or
both of:

- A **geocoder** (location search: addresses, places).
- One or more **layers** (feature search: by field text).

Picking a result zooms the map to the location or feature and
opens its popup.

## What it does

The search box accepts free text. The widget queries the
configured sources in parallel and shows a grouped result list:

- **Locations**: results from the geocoder, with the parsed
 address and coordinate.
- **Features**: matching features from each configured layer,
 with the layer name and the matched field value.

Each result is clickable.

## Configuring sources

In widget config:

- **Geocoder**. Pick from the org's configured geocoders. Set
 to "None" if location search isn't relevant for this app.
- **Layers**. Add one or more bound layers. For each:
  - **Field(s) to search**. Default: the layer's title-like
    field. Add more for multi-field search.
  - **Display template**. How the result row renders. Same
    `{field}` interpolation as popups.
  - **Result limit**. How many to return per query.

## Suggestions vs. full search

Two modes:

- **Suggestions** (default). The search runs as the user
 types; results update with a debounce. Best for short
 indexed-field searches.
- **Submit-only**. The search only runs on Enter or click. Use
 for slow or expensive searches.

## Keyboard

- `/` focuses the search box from anywhere in the app (if the
 widget is visible).
- Arrow keys navigate the result list.
- Enter activates the focused result.
- Esc closes the result list.

## Address search and My location

Address search asks the portal's geocoder (`/api/geocode`). It works
on plain HTTP. It does not ask the browser for GPS.

**My location** uses the browser's GPS API. Browsers only allow that
on a secure page: `https://` or `localhost`. A home NAS opened as
`http://192.168.x.x` can search for an address and cannot share GPS.
Tailscale Serve with the MagicDNS name is the documented way to open
that NAS over HTTPS. The portal does not turn GPS on for plain HTTP.

## Notes

- **Indexed fields search fast.** If a feature-search field is
 a long string and the layer has 100k+ features, expect slow
 results; ask an admin to add a trigram index.
- **Search scope respects sharing.** Only features the viewer
 can read appear in results; features behind a per-share geo
 limit are filtered.
