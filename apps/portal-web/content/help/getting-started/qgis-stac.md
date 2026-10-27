---
id: getting-started-qgis-stac
title: Browse public rasters from QGIS with STAC
summary: Point QGIS 3.42+ Data Source Manager at the portal's public STAC API to discover and open published rasters without a plugin.
category: getting-started
order: 50
complexity: basic
tags:
  - stac
  - qgis
  - raster
  - ogc
related:
  - reference-api
  - items-tile-layer
---

GratisGIS exposes a public STAC API at `/api/public/stac`. Stock
QGIS 3.42 and later can open that URL in **Data Source Manager**
and browse collections and items the same way it would any other
STAC catalog. You do not need the GratisGIS QGIS plugin for this
path.

## Prerequisites

- QGIS 3.42 or newer with the built-in STAC browser.
- At least one public raster / tile-layer item on the portal (private
  items are invisible on the public STAC root).
- The portal's public base URL (for example
  `https://your-portal.example`).

## Connect from QGIS

1. Open **Layer → Data Source Manager**.
2. Choose the **STAC** tab (labeling may vary slightly by QGIS
   build).
3. Add a connection whose URL is:

   ```
   https://your-portal.example/api/public/stac
   ```

4. Connect, then expand collections and items. Open an item whose
   assets point at a COG or other format QGIS already understands.

Authenticated STAC (items your signed-in user can see, including
private ones) lives at `/api/stac` and needs a bearer token. Stock
QGIS STAC cannot send portal API keys today, so keep private
rasters off this public browse path or use another client that can
authenticate.

## What this is not

- Not a CITE-certified STAC profile claim. The portal serves a
  working STAC API root with collections and item search; treat
  conformance links on the landing document as the source of truth.
- Not a replacement for the GratisGIS QGIS plugin's item browser,
  which talks OAuth to the full portal (maps, vector layers, forms).
- Not MetaSearch. Catalogue discovery for vector / records is OGC
  API Records (`/api/public/ogc/collections/catalog`); see
  **The HTTP API**.

## See also

- **The HTTP API**. STAC, Features, Records, and citation routes.
- **Tile layer**. How rasters land in the portal as items.
