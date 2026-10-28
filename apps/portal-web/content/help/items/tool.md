---
id: items-tool
title: Tool
summary: A reusable named action or analysis recipe, with a canvas that arranges the recipe as one chain.
category: items
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
  you are signed in. A recipe does **not** create a new derived
  layer or data layer as its sink — create a
  [derived layer](items-derived-layer) item (or use Analyze
  Buffer / Clip / Erase / Centroid / Dissolve / Simplify) when
  you want a saved spatial pipeline.
- **OSM relational query**

A recipe can be opened on a canvas. Dragging a step changes
where it sits. **Runs after** changes the sequence, and that
sequence is what runs. The canvas keeps a single chain. It
does not run a branch, a join, or a union. Derived layers are
the shipped way to keep a spatial pipeline whose result is
itself a layer.

## See also

- **Derived layer**. A computed layer, not a reusable button action.
