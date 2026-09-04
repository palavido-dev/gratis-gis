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
This table lists every item type with a one-line description and
a link to the dedicated page covering it.

## Map and data items

| Type | One-liner | Page |
|---|---|---|
| **Map** | Composes layers, basemap, viewport for viewing or for web-app rendering. | **Map** |
| **Data layer** | A PostGIS-backed dataset with one or more sublayers. Owned by the portal. | **Data layer** |
| **Derived layer** | Computed output of an analysis pipeline against other layers. Materialized into its own table. | **Derived layer** |
| **ArcGIS service** | A reference to an external ArcGIS REST feature service or map service. Read-only proxy. | **ArcGIS service** |
| **Tile layer** | A pre-rendered tile container (PMTiles) uploaded to MinIO. Range-served. | **Tile layer** |
| **Basemap** | A single base-layer reference (style URL, tile URL, WMS, or portal map). | **Basemap** |
| **Geo boundary** | A reusable polygon referenced by share limits, viewports, clip steps. | **Geo boundary** |

## Forms and submissions

| Type | One-liner | Page |
|---|---|---|
| **Form** | A question list bound to a data layer or submission collection; the data-collection surface. | **Form** |
| **Form submission collection** | Non-spatial backing table for forms whose responses aren't features. | **Form submission collection** |
| **Pick list** | A reusable list of coded values + labels referenced by schema fields. | **Pick list** |

## Apps and reporting

| Type | One-liner | Page |
|---|---|---|
| **Web app** | A standalone web page wrapping a map and widgets. Template-driven. | **Web app** |
| **Dashboard** | A grid of indicators, charts, and small maps. Refreshes on a schedule. | **Dashboard** |
| **Report template** | A parametrized document layout that emits a populated PDF or DOCX on run. | **Report template** |

## Catalog and supporting

| Type | One-liner | Page |
|---|---|---|
| **Folder** | A grouping of other items by id. Items can live in many folders. | **Folder** |
| **File** | Any arbitrary uploaded file (PDF, DOCX, ZIP). The catch-all item type. | **File** |
| **Tool** | A reusable, runnable analysis operation with a documented signature. | **Tool** |
| **Layer package** | An archive item that bundles a data layer's schema + symbology + features for portability. | **Layer package** |
| **Widget package** | An archive item that bundles a custom web-app widget for installation. | **Widget package** |

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
