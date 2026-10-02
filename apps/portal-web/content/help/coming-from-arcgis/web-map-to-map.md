---
id: coming-from-arcgis-web-map
title: Web map to map
summary: What WebMap JSON import and export move, and what stays on ArcGIS Online until you stage hosted feature services as portal data layers.
category: coming-from-arcgis
order: 30
complexity: intermediate
tags:
  - migration
  - web-map
  - map
related:
  - items-map
  - coming-from-arcgis-feature-service
  - coming-from-arcgis-terminology
---

An ArcGIS Online **web map** can become a GratisGIS **map**. The
import keeps the map's metadata (extent, basemap match, layer
list) and the source URLs. It does not, by itself, copy hosted
feature data into the portal.

## Where the import runs

Admins use **Admin, Migrations, From ArcGIS Online**. That flow
signs in to a registered ArcGIS Online connection, previews items,
and commits the ones you keep. The page skips apps, dashboards,
and forms.

There is no "Import web map JSON" button in the map builder, and
there is no panel that asks you to bind unmatched layers before
apply.

## Hosted feature services vs a bare WebMap

Two different outcomes:

- **Hosted feature service included in the same ArcGIS Online
 import.** The importer copies schema and features into a portal
 data layer (attachments when it can). A web map imported in that
 same run is rewritten so its layers point at those data layers.
- **WebMap JSON on its own**, or a layer whose URL was not copied
 in that run. An unmatched FeatureServer or MapServer URL becomes
 a live `arcgis-rest` layer. Public layers still draw from ArcGIS
 Online. The features stay there until you stage them as a portal
 dataset (the hosted-feature copy above, or a file upload into a
 data layer). A URL the converter does not recognise is skipped
 and listed in the import warnings.

Portal layer URLs that the portal itself exported
(`/api/items/<id>/layers/<key>/...`) round-trip back to data-layer
sources. A GeoJSON file URL becomes a GeoJSON URL layer.

## Export

`GET /items/:id/web-map.json` writes WebMap JSON whose layer URLs
point at this portal. Whether ArcGIS Pro, ArcGIS Online, or QGIS
open that file depends on the importing tool. Test it before you
treat the export as a cutover.

## See also

- **Feature service to data layer**. The copy path and the
 live-reference path.
- **Map**. The native item type.
