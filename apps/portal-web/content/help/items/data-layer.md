---
id: items-data-layer
title: Data layer
summary: An item that holds one or more PostGIS-backed feature tables.  The native equivalent of an Esri feature service.
category: items
order: 20
complexity: basic
tags:
  - data-layer
  - item-type
  - features
related:
  - items-map
  - adding-a-layer
  - bundle-export
---

A **data layer** is the native item type for feature data. It owns
one or more PostGIS tables and the schema that describes them.
Maps reference data layers; data layers reference nothing.

## What's in a data layer

- **One or more sublayers**, each backed by its own PostGIS table.
 Sublayers are what get rendered on a map.
- **A schema per sublayer**. Field list with types, domains (coded
 values, ranges), and required flags.
- **Optional related sublayers**. Non-spatial tables whose rows
 reference a parent feature. Used for one-to-many attribute data,
 inspection histories, photo metadata, etc.
- **Optional attachments**. Files (typically photos) bound to a
 specific feature. Stored in MinIO, the metadata row in the
 `feature_attachment` table.

## Importing data

Three ways to get features into a data layer:

- **Upload at create**. The new-item wizard offers a file upload
 step (Shapefile zip, GeoJSON, GeoPackage, KML).
- **Import into an existing sublayer**. The **Layer data** section
 on the detail page has an Import button per sublayer.
- **Submitted via a form**. A form item paired to this data layer
 posts new rows when respondents submit.

## Editing features

Two surfaces:

- **The feature browser** (a section on the detail page) lets you
 view, add, edit, and delete rows attribute-only.
- **A map** that references this layer lets you edit geometry
 graphically. The data layer's own detail page can't do
 geometry editing. There's no map canvas there.

## Exporting

The **Export** dropdown on the feature browser produces CSV, XLSX,
or a full Bundle (XLSX + related tables + attachments) as a ZIP.
See **Bundle export**.

## Versions

Data layers are versioned bitemporally: every edit becomes an
observation in the engine's log. This means:

- **Undo works at every level**. Single-row, batch, layer-wide.
- **Time-travel queries**. Show me this layer as of last Tuesday.
- **Audit trail**. Every observation records who changed what
  and when.

The bitemporal engine is mostly invisible day-to-day. Where you
see it: the **As of** time slider in the map editor and the
**History** column when you right-click a feature in the
attribute table.

## Sync versions and conflicts

Each sublayer also carries a monotonic **sync version** that bumps
when a feature write batch is accepted. Field apps and the QGIS
plugin can ask for only the changes since a version they already
have (`delta?since=N` on the HTTP API), instead of re-downloading
the whole layer. The field PWA offline refresh uses that delta when
it already has a cursor, so a second download only pulls what
changed.

When two editors change the same feature and one save loses the
optimistic concurrency check, the losing edit is kept on the layer
as a **sync conflict**. Open the **Layer data** panel on the item
page to review recent conflicts after a sync, so a field crew can
see what did not land and decide what to retry.

Field offline push dry-runs each queued **update** and **delete**
with `checkOnly=true` before the real write. A conflict or schema
refusal parks that edit on the device with the server reason and
does not transfer it; the conflict artifact is still recorded for
review. New features (creates) upload without a dry-run.

If you can edit the layer, each conflict offers **Re-apply**. Confirm
shows the losing side next to what was current at conflict time.
Re-apply writes the losing update onto the live feature (with the
current observation id), deletes when the losing side was a delete,
or recreates the feature when it is gone. Conflicts stay listed after
a successful re-apply until a later dismiss path lands.
