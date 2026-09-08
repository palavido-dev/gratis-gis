---
id: reference-item-types
title: Item types
summary: The full catalog of GratisGIS item types in one place, with one-line descriptions and links to each item's detail page.
category: reference
order: 10
complexity: basic
tags:
  - reference
  - item-types
  - catalog
related:
  - what-is-gratisgis
  - coming-from-arcgis-terminology
---

Every addressable thing in GratisGIS is an **item**. Items have
a stable id, a type, an owner, sharing, tags, and a detail page.
These tables list every current item type with a one-line
description and a link to the dedicated page covering it. Three
older types that are being phased out are listed separately at the
end.

## Map and data items

| Type | One-liner | Page |
|---|---|---|
| **Map** | Composes layers, basemap, viewport for viewing or for web-app rendering. | **Map** |
| **Data layer** | A PostGIS-backed dataset with one or more sublayers. Owned by the portal. | **Data layer** |
| **Derived layer** | Computed output of an analysis pipeline against other layers. Materialized into its own table. | **Derived layer** |
| **Connected service** | A reference to an external service the portal reads live: an ArcGIS map, feature, image or geocoding service, or an OGC WMS, WFS or WMTS endpoint. One type for all of them; the protocol is recorded on the item. | **Connected service** |
| **Tile layer** | A pre-rendered tile container (PMTiles) uploaded to the portal's object storage. Range-served, and usable as a basemap source. | **Tile layer** |
| **Point cloud** | A 3D lidar point cloud uploaded as a COPC file and served as an ordinary layer; viewers stream only the part in view. | **Point cloud** |
| **Basemap** | A single base-layer reference: a style URL, a tile URL, or a WMS endpoint. (Composing a basemap from a portal map is planned but not built.) | **Basemap** |
| **Geo boundary** | A reusable polygon referenced by share limits, viewports, clip steps. | **Geo boundary** |
| **Geocoding service** | Turns one of your own data layers (parcels, addresses, places) into an address search by naming the fields to match on. Appears in the map search box alongside external geocoders. | **Geocoding service** |

## Forms and collection

| Type | One-liner | Page |
|---|---|---|
| **Form** | A question list bound to a data layer or submission collection; the data-collection surface. | **Form** |
| **Form submissions** | Non-spatial backing table for forms whose responses aren't features. | **Form submissions** |
| **Data collection** | A field deployment: a map plus the forms bound to its editable layers and an optional offline area, opened on a phone or tablet by collectors, with or without signal. Share it with a link or QR code. | **Data collection** |
| **Pick list** | A reusable list of coded values + labels referenced by schema fields. | **Pick list** |

## Apps and reporting

| Type | One-liner | Page |
|---|---|---|
| **Web app** | A standalone web page wrapping a map and widgets. Template-driven; editors, viewers and dashboards are all web apps started from different templates. | **Web app** |
| **Editor** | An older, standalone form of the editing app. New editors are created as a web app with the Editor template; existing Editor items keep working. | **Editor** |
| **Web app template** | A saved blueprint for a custom web app. Built-in starters are provided and you can save your own from an existing app; the New item wizard clones one into a fresh web app. | **Web app template** |
| **Theme** | A shareable colour and typography palette for custom web apps, picked in the app designer. Built-in starters are provided. | **Theme** |
| **Print template** | A paper layout (page size, positioned map, legend, text, declared parameters) that a web app's Print tool fills in and renders to PDF. | **Print template** |
| **Dashboard** | Not a working type. Dashboards shipped as a web app layout (the KPI Dashboard and Operations Board templates); the few Dashboard items created before that show a notice pointing there and have no editor. | **Web app** |
| **Report template** | Reserved for a document layout that renders rows or submissions to PDF or Word. Not built yet; the item page shows a placeholder. | **Report template** |

## Automation

| Type | One-liner | Page |
|---|---|---|
| **Tool** | A reusable, runnable analysis operation with a documented signature. | **Tool** |
| **Script** | User-authored Python (or a `.ipynb` notebook) stored as an item and run on the server, on demand or on a schedule, in a sandboxed container. Off by default; an operator enables it. There is no in-browser notebook editor. | **Script** |

## Catalog and supporting

| Type | One-liner | Page |
|---|---|---|
| **Folder** | A grouping of other items by id. Items can live in many folders. | **Folder** |
| **File** | Any arbitrary uploaded file (PDF, DOCX, ZIP). The catch-all item type. | **File** |
| **Layer package** | Reserved for an archive bundling a layer's schema, symbology and features for offline use. Not built yet; the item page shows a placeholder. | **Layer package** |
| **Widget package** | Reserved for an archive bundling a custom web-app widget for installation. Not built yet; the item page shows a placeholder. | **Widget package** |

## Deprecated types

These three still appear on existing items but nothing creates them
any more. Each has been superseded by **Connected service**, and
existing items have already been rewritten to it.

| Type | Superseded by |
|---|---|
| **ArcGIS service** | Connected service with an ArcGIS protocol |
| **WMS service** | Connected service with the WMS protocol |
| **WFS service** | Connected service with the WFS protocol |

## What every item has

Regardless of type, every item carries:

- A **stable id** in URLs and API responses.
- A **title and description**.
- A **type** (one of the above; immutable after creation).
- An **owner** (the user who created it).
- A **sharing tier** (Owner only / Organization / Public; plus
 optional per-user / per-group shares).
- **Tags** (free-form, used for search faceting).
- A **created_at and updated_at**.
- A **dependency record** (links to other items it references,
 and items that reference it).

## Where item-type labels live

Every surface that shows an item's type reads its label from a single
shared helper rather than printing the raw type, so a rename lands
everywhere at once and no two screens disagree about what a type is
called.

## Notes

- **No custom item types.** v1 doesn't expose a "define your own
 item type" surface. Pick from the catalog above.
- **Migration mismatches**. An AGO item type with no direct
 equivalent here (Story Map, Geoenrichment service) doesn't
 have a stub item type; see **Coming from ArcGIS Online** for
 the gap list.
