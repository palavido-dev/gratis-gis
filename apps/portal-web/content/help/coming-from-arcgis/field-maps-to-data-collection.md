---
id: coming-from-arcgis-field-maps
title: Field Maps to data collection
seoTitle: "ArcGIS Field Maps alternative: open source offline data collection"
summary: "How a Field Maps workflow maps onto a GratisGIS data collection item and the field app. The ArcGIS Online importer brings over Field Maps maps, forms and offline areas."
category: getting-started/coming-from-arcgis
order: 35
complexity: basic
tags:
  - migration
  - field-maps
  - field
  - offline
  - data-collection
related:
  - items-data-collection
  - coming-from-arcgis-survey123
  - coming-from-arcgis-feature-service
  - items-form
---

In ArcGIS Online, a field crew opens a web map in the Field Maps
app, edits the layers the map allows, and takes areas offline. In
GratisGIS the same job is a **data collection** item opened in the
field app. The field app runs in the phone's browser and can be
added to the home screen, so there is nothing to install from an
app store.

It is not a drop-in for Field Maps, but the ArcGIS Online importer
brings most of the setup over. See
[What the importer brings over](#what-the-importer-brings-over).

## What lines up

| Field Maps | GratisGIS | Notes |
|---|---|---|
| Web map prepared for field use | **Map** bound to a **data collection** item | The data collection item picks the map and the editable layers. |
| Editable layer settings | **Editable layers** on the data collection item | Only layers marked editable show in the add and edit flows. View-only layers still draw. |
| Smart form or popup form | A form built from the layer's fields, or a **form** item bound to the layer | See [Form designer](/help/forms/form-designer). |
| Offline map area | **Offline areas** on the item, plus **Download for offline** on the phone | Features, forms and pick lists download on the device. |
| Sync | The sync queue in the field app | Edits wait on the phone and upload when it is back online. |
| Sharing the map to a field group | Sharing the **data collection** item | Who can edit still follows each data layer's own sharing. |
| App link or QR code | **QR code** and **copy link** on the item page | Collectors sign in on their own phone. |

## What the importer brings over

When the importer copies a web map that was set up for Field Maps,
it also makes:

- **A data collection** that opens the imported map in the field app.
- **A form for each layer that had a Field Maps form.** The form
  keeps the fields, their order, labels, groups and text. Radio
  buttons, drop-downs, multi-line text, barcode scanning and date
  pickers carry over.
- **Form rules.** Show, required and editable rules, and calculated
  values, are converted from Arcade. Rules that compare fields, check
  for empty values, use `IIf`, `IsEmpty`, `Includes` or simple text
  and number functions convert. A rule that reads other layers or
  uses more Arcade than the form rules support is dropped, and the
  import report says which field it was on and what happens instead.
- **Offline areas** from the map's offline map areas. Build each one
  on the data collection's page before crews download.
- **Editing settings.** A layer that allowed editing in ArcGIS Online
  allows it here, unless the web map turned editing off for it.

A web map counts as set up for Field Maps when Field Maps is not
turned off for it, it has a layer crews can edit, and it has a Field
Maps form or the keywords ArcGIS Online adds to maps used for field
editing or offline work.

The importer does not bring over attachment and related records
elements, Field Maps layer templates, geofences, tracking, or
Field Maps Designer settings stored outside the web map. Photos still
attach through the field app when the layer has attachments turned
on.

## Moving a Field Maps workflow over by hand

If you used the importer, check the data collection it made and skip
to step 5. Otherwise:

1. Move the layers first. See
   [Feature service to data layer](/help/coming-from-arcgis/feature-service-to-data-layer).
   Check that pick lists came over for any field that used a coded
   value domain.
2. Build or import the map the crew uses. See
   [Web map to map](/help/coming-from-arcgis/web-map-to-map).
3. If the crew used a Survey123 form, import its XLSForm into a
   **form** item. See
   [Survey123 to form](/help/coming-from-arcgis/survey123-to-form).
   Otherwise each layer gets a form built from its fields.
4. Create a **data collection** item. Pick the map, mark the
   editable layers, and bind a form to any layer that needs one.
5. If the crew works without signal, prepare an offline area on the
   item page.
6. Share the data collection item with the crew. Give the crew
   **can edit** on the data layers they collect into.
7. Send the link or show the QR code. Have one person download the
   area, collect a test feature in airplane mode, and sync it before
   the whole crew goes out.

## Offline and sync differences

- **Download happens on the phone.** The collector taps **Download
  for offline** before leaving. Basemap tiles only work offline if an
  offline area was prepared and its tiles were downloaded.
- **Conflicts park on the device.** Updates and deletes are checked
  against the server before they are written. If a feature changed
  on the server in the meantime, the edit waits with the reason, and
  someone resolves it on the data layer's **Layer data** panel with
  **Re-apply** or **Dismiss**. See
  [Data collection](/help/items/data-collection).
- **No replica geodatabase.** There is no offline geodatabase or
  mobile map package. The phone keeps its own cache in the browser's
  storage.

## What is not here

- No import of Field Maps projects, offline areas or map packages.
- No native iOS or Android app. The field app is a web app.
- No direct connection to an external GNSS receiver. The field app
  uses the location the phone's browser reports, so a receiver helps
  only when the phone itself uses it for location. Test your accuracy
  requirements before you plan a project around it.
- No Field Maps Designer equivalent beyond the data collection item
  and the form designer.

## Related

- [Data collection](/help/items/data-collection) has the full
  reference for deployments, offline download and sync.
- [Form](/help/items/form) covers survey-style capture without a
  map.
