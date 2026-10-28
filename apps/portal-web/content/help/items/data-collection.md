---
id: items-data-collection
title: Data collection
summary: A field deployment that opens a map plus editable layers and forms on a phone or tablet, with offline download, sync, and QR / link share.
category: items
order: 35
complexity: basic
tags:
  - data-collection
  - item-type
  - field
  - offline
related:
  - items-map
  - items-form
  - items-data-layer
  - reference-item-types
  - coming-from-arcgis-terminology
---

A **data collection** item is a field deployment. Authors bind a
**map**, mark which layers are editable in the field, optionally
bind a custom **form** per layer, and optionally prepare offline
areas. Collectors open the field PWA on a phone or tablet, add and
edit features with or without signal, then sync when they are back
online.

It is **not** Esri Field Maps and **not** Survey123. The portal
ships its own field PWA and form runtime. Survey-style capture
without a map still uses a **form** item (and XLSForm import where
it fits). See **Coming from ArcGIS Online** terminology for the
honest Field Maps / Survey123 mapping.

## What a deployment includes

- **A map**. Layers, basemap, and default viewport the collector
  sees in field mode (`/items/<id>/field`).
- **Editable layers**. Only layers marked editable for field
  deployments appear in Add / edit flows. View-only layers still
  draw.
- **Forms**. By default each editable layer uses a form drawn from
  its schema. Optional per-layer form bindings override that.
- **Optional offline areas**. Prepared extents and detail levels
  for basemap / tile warm-up on the item page. Feature download for
  offline still happens on the device (see below).

## Opening on a phone

On the data collection item page, **Open field-mode runtime** starts
the PWA on the device you are already using. For handoff from a
desk:

- Scan the **QR code** on the item page (built from the browser's
  public origin plus `/items/<id>/field`).
- Or **copy the link** and send it.

Collectors must be able to sign in (or already have a session) on
that phone. Sharing the data collection item controls who can open
the deployment; editing still follows each data layer's permissions.

## Offline: Download and Refresh

In the field runtime **More** menu (and on the Layers sheet):

- **Download for offline** caches editable-layer features (scoped
  to the deployment bbox when configured), bound form schemas, and
  pick lists into IndexedDB on that device.
- **Refresh offline cache** pulls again. When the device already
  has a sync cursor, refresh prefers the data layer **delta** API
  instead of re-downloading every feature. See **Data layer**
  (sync versions).
- Partial downloads surface an honest incomplete warning (missing
  layers, forms, pick lists, or out of storage). Do not assume a
  "Cached" line means every layer landed.

Basemap tiles may still be empty offline if tiles were not warmed;
feature capture and forms are the offline contract today. Remove
from device wipes that deployment's local cache (and warns when
unsynced edits would be lost).

## Sync queue and conflicts

Edits made offline (and online writes that fall back to the queue)
sit in a local queue. When online, the queue badge can **Sync**;
offline it only shows that edits are waiting.

Queued **updates** and **deletes** dry-run with `checkOnly=true`
before the real write. A conflict or schema refusal parks that edit
on the device with the server reason. New creates upload without a
dry-run. Review recent conflicts on the paired
[Data layer](items-data-layer) item (**Layer data** panel):
**Re-apply** or **Dismiss**. That page's **Sync versions and
conflicts** section is the full Re-apply / Dismiss guide.

## What this is not

- Not a Field Maps project import, offline geodatabase replica, or
  ArcGIS Mobile Map Package workflow.
- Not Survey123 Connect / web designer parity; use a **form** item
  for survey-first flows.
- Not a promise that every basemap tile works offline without
  preparing areas and warming tiles.
- Not multi-user CRDT merge on drawings; sync conflicts are
  optimistic-concurrency artifacts you resolve on the layer.

## Related

- **Map** — the deployed composition.
- **Form** — custom bindings and survey-style capture.
- [Data layer](items-data-layer) — sync versions, delta refresh,
  **Layer data** conflict **Re-apply** / **Dismiss**.
- **Item types** — catalog one-liner for this type.
