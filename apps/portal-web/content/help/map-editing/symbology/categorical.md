---
id: symbology-categorical
title: Categorical symbology
seoTitle: "Categorical symbology: style features by unique values"
summary: Render each feature differently based on the value of one field. Status colors, asset types, land use classes.
category: map-editing/symbology
order: 20
complexity: basic
tags:
  - symbology
  - categorical
related:
  - symbology-simple
  - symbology-graduated
  - items-pick-list
---

**Categorical symbology** picks a fill / stroke / icon per feature
based on the value of one field. Use for status colors,
inspection results, asset type, land-use codes, anything where
the field has a small set of discrete values that each deserve a
distinct look.

## Inputs

- **A layer** on the map.
- **A field** that drives the symbology. Most useful when the
 field's values are bounded (an enum, a pick list, a status code).
- **A class per value**: each known value gets its own
 fill / stroke / icon / size.
- **A fallback class** for values not in the list (or NULL).

## How to set it

1. In the map builder's layer style panel, pick **Categorical**.
2. Pick the **field**.
3. Click **Auto-fill from values** to populate one class per
 distinct value in the layer. The portal samples the layer and
 adds an entry per value.
4. Adjust each class's symbol (fill, stroke, icon, size).
5. Either accept the fallback class or set "no value" features
 to invisible.
6. **Save** the map.

If the field is bound to a **pick list** item, the importer
pre-fills class names from the pick list labels and color from
the pick list color (when set). Adding a new pick list entry
later doesn't auto-create a class on this layer; you re-open the
style panel and pick the new value.

## Examples

- **Inspection status**: `passed` → green, `needs-repair` →
 amber, `failed` → red, anything else → gray.
- **Hydrant type**: `dry` → blue, `wet` → cyan, `private` →
 yellow.
- **Land use**: 12 codes from the local zoning ordinance, each
 with its own fill color matching the printed map legend.

## Notes

- **NULL is a value too.** If you don't add a class for NULL, the
 fallback handles it. Common pattern: NULL features become a
 light-gray outline so they're visible but obviously incomplete.
- **Don't categorize on a high-cardinality field.** Don't pick
 categorical on a field with hundreds of distinct values; the
 legend becomes unreadable and the render slows. Use **Graduated**
 (for numeric) or filter to a subset.
- **Order of classes** matters when values overlap visually
 (large polygons cover smaller ones). The order in the style
 panel is the draw order; drag to reorder.
