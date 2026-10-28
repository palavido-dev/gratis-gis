---
id: items-tool
title: Tool
summary: A reusable named action or analysis recipe, with a canvas that arranges the recipe as one chain.
category: items/maps-and-apps
order: 170
complexity: advanced
tags:
  - tool
  - item-type
  - analysis
related:
  - items-derived-layer
---

A **tool** is a reusable named action. A web app button can run
it. The detail page edits one of these kinds:

- **Open URL** or **open item**
- **Export layer**
- **Recipe**: an ordered analysis recipe, including OSM as a
  source. Selection and "OSM features on the map" are the
  outputs the runner supports. An OSM overlay area of interest
  can be a drawn shape for everyone, or a layer / selection when
  you are signed in. OSM overlay / relational / reverse-geocode
  results set `truncated` when Overpass (or a nearest-N /
  selection cap) returned more features than the response keeps —
  do not treat a capped overlay as a complete census of the AOI.
  A recipe does **not** create a new derived layer or data layer
  as its sink — create a [derived layer](items-derived-layer)
  item, or use a data layer's **Analyze** guided actions (Buffer,
  Clip, Erase, Centroids, Convex hulls, Bounding boxes, Dissolve,
  Simplify, Densify, Vertices, Calculate geometry, Nearest
  neighbor, Fishnet on polygons, Contour on points, Group by
  (one key, count/sum/avg), Top N, Random sample; see
  [Derived layer](items-derived-layer)), when you want a saved
  spatial pipeline. Filter, Spatial filter, Spatial join, and
  Calculate field stay on Create → Derived layer (no Analyze
  shortcut).
- **OSM relational query**

A recipe can be opened on a canvas. Dragging a step changes
where it sits. **Runs after** changes the sequence, and that
sequence is what runs. The canvas keeps a single chain. It
does not run a branch, a join, or a union. Derived layers are
the shipped way to keep a spatial pipeline whose result is
itself a layer.

Public `POST /api/tools/:id/run` is throttled at **30 requests
per minute per IP** (tighter than the global API default).
Anonymous Overpass-backed tools are an easy egress burn if left
at the global ceiling; expect HTTP 429 when you exceed it.

## See also

- [Derived layer](items-derived-layer). A computed layer, not a
  reusable button action — and the full Analyze shortcut list.
