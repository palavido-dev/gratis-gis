---
id: map-editing-expression-fields
title: Expression fields
seoTitle: "Computed fields for labels, popups and styling, including related records"
summary: "Add values computed for every feature, such as a related table's latest date or the nearest hydrant, and use them in labels, popups, styling and filters."
category: map-editing
order: 22
complexity: intermediate
tags:
  - expressions
  - labels
  - popups
  - symbology
  - arcade
related:
  - reference-expression-language
  - map-editing-labels
  - map-editing-popups
  - coming-from-arcgis-arcade
---

An **expression field** is a value worked out for every feature of a
map layer from an [expression](/help/reference/expression-language).
Once it exists, use it anywhere a field can go:

- In a **label**: `{{expr.last_inspected}}`.
- In a **popup**: pick it in the field list, or write it into a popup
  template.
- In **styling**: choose it as the field for unique values or class
  breaks.
- In a **filter**: pick it like any other field.

Expression fields can read the feature's related records, other
layers and nearby features. This is what ArcGIS Arcade does in popups
with FeatureSets, and here it also works in labels and styling.

## Add one

1. Open the map, select the layer, and open the **Expressions** tab.
2. Choose **Add expression field**.
3. Give it a **name** (letters, digits and underscores) and an
   optional **label** for popups.
4. Write the expression. The builder lists the layer's fields, every
   function, and the related tables and layers you can read, and
   previews the result on real features as you type.
5. Use it as `expr.<name>` in the Labels, Style, Filter or Popup tab.

## Examples

| Name | Expression | Shows |
|---|---|---|
| `last_inspected` | `max(related('inspections'), {{inspected_on}})` | The latest inspection date. |
| `times_inspected` | `count(related('inspections'))` | How many inspections. |
| `days_since` | `date_diff(today(), max(related('inspections'), {{inspected_on}}), 'days')` | Days since the last one, for styling overdue features. |
| `hydrant` | `nearest(layer('Hydrants'), 1000, 'feet').hydrant_id` | The closest hydrant within 1,000 feet. |
| `district` | `first(containing(layer('Districts'))).name` | The district a point falls in. |
| `acres` | `round(area($feature, 'acres'), 1)` | The polygon's area. |

A label such as `{{name}} ({{expr.times_inspected}})` then reads
"Nest 14 (3)".

## Where they are worked out

Expression fields work on layers stored in this portal (data layers).

- **On the map**, the server works them out into the map tiles, with
  your own access: rows you cannot see are not counted.
- **In popups**, the values come from the same tiles.
- **In the field app with no signal**, the device works them out from
  what it downloaded, including records captured offline and not yet
  sent. Related tables and layers an expression reads are downloaded
  with the area. Records others added since the download show after
  the next sync.

## Notes

- An expression field with a mistake is left out of the tiles rather
  than blanking the layer. The builder shows the mistake.
- Expressions that read other layers make each map tile a little
  slower to build, since every feature runs its own lookup. Give
  `nearest` a distance limit on very large layers.
- The layers an expression reads are listed under **Depends on** on
  the map's item page, and the map's sharing checks include them.
- Web maps imported from ArcGIS bring their Arcade label and popup
  expressions across as expression fields when they translate. The
  import report lists the ones that do not.
