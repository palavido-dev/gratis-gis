---
id: map-editing-popups
title: Popups
seoTitle: "Configure map popups: fields, attachments and actions"
summary: "Customize what shows when a user clicks a feature: title, body, field list, attachments, links."
category: map-editing
order: 40
complexity: basic
tags:
  - popup
  - map-editing
related:
  - map-editing-labels
  - map-editing-filters
---

A **popup** is the panel that opens when a user clicks (or taps) a
feature. By default it shows the layer's title and every field;
the popup config lets you make it useful instead of a wall of
text.

## What you can configure

- **Title template.** Same `{field}` interpolation as labels.
 `"{name}"`, `"{name}: {status}"`, `"Parcel #{parcel_id}"`.
- **Body template.** A rich-text body with `{field}` references,
 line breaks, bullet lists, links, optional images.
- **Field list mode** (alternative to body template). Pick which
 fields show, in what order, with optional per-field labels and
 formatting (date format, number precision, percent).
- **Attachments section.** Toggle on if the layer has attachments;
 thumbnails open in a lightbox.
- **Related-table section.** Toggle on if the layer has child
 sublayers; each related row becomes a sub-item in the popup.
- **Actions.** Buttons that appear at the bottom of the popup.
 Built-ins: "Zoom to", "Open in detail page", "Edit", "Run
 report" (if a report template is configured), "Copy link to
 feature". Custom actions: a button that opens a URL with field
 values interpolated.

## How to set it

1. Open the map in the builder.
2. In the layer list, click **Popup**.
3. Pick a mode: **None**, **Title + fields**, **Title + body**.
4. Edit the title and body.
5. Pick fields and formatting (or leave defaults).
6. Toggle attachments / related tables / actions.
7. Save.

## Disabling popups

A layer can have **no popup**, in which case the click does
nothing. Useful for basemap-style reference layers where the
features aren't interactive (parcel outlines under a thematic
overlay, for example).

## Notes

- **Popups don't render expressions.** No conditional logic in
 the title or body. If you need "show 'Open' if status = 'O',
 'Closed' otherwise," compute a derived column on the layer and
 reference that.
- **Long bodies scroll.** A popup has a maximum height; longer
 bodies get a scroll bar inside the popup rather than pushing
 the map.
- **Mobile popups** are full-width bottom sheets rather than
 floating boxes; the same template renders.
