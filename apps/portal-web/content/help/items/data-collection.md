---
id: items-data-collection
title: Data collection
seoTitle: "Field data collection deployments with offline sync"
summary: A field deployment that opens a map plus editable layers and forms on a phone or tablet, with offline download, sync, and QR / link share.
category: items/field-and-forms
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
  its schema. Optional per-layer form bindings override that. The
  map tap supplies the location, so a bound form's own location
  question is hidden in the field app. The form still shows it when
  someone fills it in on its own page.
- **One-handed use**. Layers, Locate and the + button (collect) sit
  in one stack in the bottom right corner, in reach of the thumb
  holding the phone. The map scale and credits are in the other
  corner, and Search is at the top left. For the left hand, open the
  **More** menu (the three dots at the top right) and turn on
  **Collect and locate buttons on the left**. The setting is saved on
  that device.
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

## Adding features

Tap **+** (pick a feature type first when the deployment has more
than one). The form opens straight away, over half of the map, for a
point, a line or a polygon. While it is open a pin sits in the middle
of the map and **Locate** is the only button left on the map; pinch
to zoom.

- **A point** starts where the pin is. Its form's **Location** shows
  the coordinates, and **Update point** moves the point to the pin
  again. The placed point is marked on the map, and only the button
  moves it.
- **A line or polygon** gets its first vertex where the pin is. The
  form's **Shape** bar shows how many vertices there are: **Add
  vertex** puts the next one at the pin and **Undo** removes the last.
  The shape is drawn on the map as it grows. A line needs 2 vertices
  and a polygon 3 (it closes itself) before it can be saved.
- **The pin goes where the map goes.** Tap **Locate** and the map,
  with the pin, follows your GPS position; Update point and Add
  vertex then use the fix itself. Move the map by hand, or tap a spot
  to bring it under the pin, and the pin stays where you put it until
  you tap **Locate** again.
- **Snapping.** The pin snaps to the nearest vertex, or failing that
  the nearest edge, of a feature already on the map; its ring turns
  magenta when it would. Turn it off with **Snap to features** in the
  **⋮** menu; the choice is kept on the device. A GPS position is
  never snapped.

**Copy** in a feature's details opens a new form the same way, with
the feature's attributes filled in.

## GNSS receivers and location details

The field app uses the phone's own location by default. For better
accuracy, connect an external GNSS receiver:

1. Pair the receiver with the phone or computer in its Bluetooth
   settings, or plug in a USB receiver on a computer.
2. In the field app, open the **More** menu and tap **Connect a GNSS
   receiver**, then pick the receiver.
3. The strip under the header shows the fix type, satellites and
   accuracy, for example "RTK fixed · 18 sats · ±0.02 m". When the
   receiver does not send its own error estimate (an NMEA GST
   sentence), the accuracy is a rough figure from HDOP and reads
   "about".

Connecting a receiver needs Chrome on Android, or Chrome or Edge on a
computer. Other browsers, including every browser on iPhone and
iPad, cannot reach a receiver directly. There, use the receiver
maker's app to feed the device's own location (a mock location app
on Android, or the receiver's app on iOS), and the field app picks it
up like any other location.

**Location details on new points.** When a point is collected at the
current location, the app fills these columns if the layer has them,
and leaves them alone otherwise:

| Detail | Column names |
|---|---|
| Latitude, longitude, altitude | `lat`, `lon`, `altitude`, `esrignss_latitude`, `esrignss_longitude`, `esrignss_altitude` and similar |
| Horizontal and vertical accuracy | `h_accuracy`, `v_accuracy`, `esrignss_h_rms`, `esrignss_v_rms` |
| Fix type | `fix_type`, `esrignss_fixtype` (a code in a number column, text in a text column) |
| Satellites | `num_sats`, `esrignss_numsats` |
| PDOP, HDOP, VDOP | `pdop`, `hdop`, `vdop`, `esrignss_pdop`, `esrignss_hdop`, `esrignss_vdop` |
| Correction age and base station | `corr_age`, `station_id`, `esrignss_correctionage`, `esrignss_stationid` |
| Receiver and source | `gnss_receiver`, `position_source_type`, `esrignss_receiver`, `esrignss_positionsourcetype` |
| Fix time | `fix_at`, `esrignss_fixdatetime` |

The `esrignss_` names are the ones ArcGIS Field Maps uses, so a layer
moved from ArcGIS Online keeps filling the same columns. Receiver
details stay empty when the point came from the phone's own location.
A value the form already has is never overwritten.

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
[Data layer](/help/items/data-layer) item (**Layer data** panel):
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
- [Data layer](/help/items/data-layer) — sync versions, delta refresh,
  **Layer data** conflict **Re-apply** / **Dismiss**.
- **Item types** — catalog one-liner for this type.
