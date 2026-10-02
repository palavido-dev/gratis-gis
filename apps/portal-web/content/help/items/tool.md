---
id: items-tool
title: Tool
summary: A reusable named action or analysis recipe. The node-graph builder is not built.
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
 source. Selection and "OSM features on the map" are outputs
 you can pick. Saving the result as a new derived layer or a
 new data layer is still disabled in that editor.
- **OSM relational query**

There is no node-graph canvas. Derived layers are the shipped
way to keep a spatial pipeline whose result is itself a layer.

## See also

- **Derived layer**. A computed layer, not a reusable button action.
