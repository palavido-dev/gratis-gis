---
id: bundle-export
title: Bundle export
summary: Pack a data layer (and optionally its related tables and feature attachments) into a single ZIP archive.
category: map-editing
order: 25
complexity: intermediate
controls:
  - id: bundle-export-button
    label: "Bundle (.zip) option in the Export dropdown"
tags:
  - export
  - bundle
  - attachments
related:
  - items-data-layer
  - widget-export
---

A **bundle export** packs everything you'd want to hand a client
into one ZIP file: the layer's features as an Excel workbook, the
related-table rows for the same features, and every feature
attachment (typically photos) bound to those features.

This is the "give my customer the data" workflow, and it's the
biggest single improvement over the AGO export (which gives you
the spreadsheet but leaves you to manually match attachments by
GlobalID).

<!-- screenshot: bundle export modal with the scope toggle, include-related, include-attachments, and the attachment-prefix dropdown -->
## How to run one

You can reach Bundle from two surfaces:

- **Data layer detail page → Layer data → Attributes → Export → Bundle**
- **Attribute table → Export → Bundle** (only when the active
 layer is sourced from a data layer)

Both surfaces open the same modal.

## Options

| Option | What it does |
|---|---|
| **Scope** | All features, or Selected features (when reachable from a context that has a selection, eg the attribute table). |
| **Include related tables** | Drops a sheet into the workbook for each related sublayer. Auto-hidden when the layer has no related tables. |
| **Include attachments** | Pulls every attachment for every surviving feature into the `attachments/` folder. Off if you only need the spreadsheet. |
| **Filename prefix** | Optional layer field whose value prefixes each attachment filename (matches the ArcGIS Pro export script convention). |
| **Organize by field** | Optional second field that puts each attachment in a subfolder named by the field value. |

## Output layout

```
<layer name>.zip
 <layer name>/
 data.xlsx
 attachments/
 <prefix>_ATT<id>_<original>.jpg
 ...
```

When **Organize by field** is set:

```
 attachments/
 <split-value>/
 <prefix>_ATT<id>_<original>.jpg
 ...
```

## Selection cascade

When you bundle with the **Selected features** scope:

- The parent layer is filtered to the selected features.
- Each related table is filtered to rows that reference a surviving
 parent (heuristic match. The related row keeps if any of its
 property values matches a surviving parent's id).
- Each surviving feature's attachments are included.

In effect, "give me a packet for these 12 parcels" hands back a
clean self-contained archive with just those 12 parcels' data.

## Limits

The Bundle currently runs in the browser. For a few thousand
features with photos, that's instant; for a 50,000-feature layer
with gigabytes of photos, you'll watch the modal say "Fetching
attachments 23 / 412..." for a while. A server-side streaming
endpoint is on the roadmap for that case.
