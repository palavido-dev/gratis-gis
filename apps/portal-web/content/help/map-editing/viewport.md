---
id: map-editing-viewport
title: Viewport
summary: The default center, zoom, bearing, and pitch a map opens at, plus optional bookmarks for saved views.
category: map-editing
order: 50
complexity: basic
tags:
  - viewport
  - map-editing
  - bookmarks
related:
  - items-map
  - items-geo-boundary
---
![Map builder with Layers rail and map canvas](/help/map-editing/map-builder-overview.png)

The **viewport** is the part of the world a map shows when a user
opens it. Center, zoom, bearing, pitch. Set the default to
whatever's useful for a first-time viewer.

## Setting the default viewport

In the map builder:

1. Pan and zoom to the view you want as the default.
2. (Optional) Tilt and rotate; the current 3D bearing and pitch
 are part of the saved viewport.
3. Click **Use current view as default** in the viewport panel.
4. Save the map.

The next time anyone opens this map, the default is what they
see.

## Bookmarks

A bookmark is a saved viewport with a name. The map can carry as
many as you want. Viewers see them in the bookmark dropdown (if
the bookmark widget is enabled on the consuming web app) or in
the bookmark list on the detail page.

Common patterns:

- One bookmark per project site.
- "Overview" and "Detail" bookmarks for the same map.
- A bookmark per neighborhood for a city-wide map.

To create one:

1. Pan / zoom to the view.
2. Click **Add bookmark**.
3. Name it.
4. Save the map.

## Scoping to a geo boundary

Sometimes "default viewport" really means "open zoomed to this
polygon". The viewport panel has a **Bind to geo boundary** action
that takes a **Geo boundary** item; on open, the map computes the
fit-bounds for that polygon. Useful when the polygon's extent
changes over time (annexation, redistricting): you don't have to
remember to update the map.

## Maximum and minimum zoom

The map can constrain how far in / out users can zoom:

- **Minimum zoom** prevents zooming out below a certain level
 (common: don't let users see the world, since this map's data
 only covers your county).
- **Maximum zoom** caps the zoom-in (the basemap goes blurry
 beyond a certain zoom anyway).

## Notes

- **Bearing and pitch** are 3D rotation. Default is bearing 0
 (north up) and pitch 0 (top-down). Bearing != 0 is a "rotated
 north" map; pitch != 0 is an oblique view.
- **Bookmark order** in the dropdown matches the order in the
 viewport panel; drag to reorder.
- **Per-user "last viewed"** is separate from the map's default
 viewport. Browsers remember where each user left off; the
 default is the first-visit experience.
