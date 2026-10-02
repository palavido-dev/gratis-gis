---
id: coming-from-arcgis-feature-service
title: Feature service to data layer
summary: Move an ArcGIS Online hosted feature service into a GratisGIS data layer. Schema, symbology, and features all come over.
category: coming-from-arcgis
order: 20
complexity: intermediate
tags:
  - migration
  - feature-service
  - data-layer
related:
  - items-data-layer
  - items-arcgis-service
  - coming-from-arcgis-terminology
---

A hosted feature service can become a portal **data layer**. That
copy is a separate step from importing a web map. A WebMap JSON
import that only keeps the FeatureServer URL still draws from
ArcGIS Online.

Admins can run the copy from **Admin, Migrations, From ArcGIS
Online**. When the preview marks a hosted feature service for
import, the commit copies schema and features into PostGIS and,
if a web map in the same run referenced that service, rewrites
the map onto the new data layer. Referenced services that are
not hosted stay as live pointers.

The manual export below is the same cutover when you would rather
move a file than use that importer.

## Two paths

Pick one based on whether you want a copy or a live reference.

### Path A: copy the data over

You're cutting the dependency. Use this when GratisGIS will own
the data from here on.

1. **Export from AGO**. From the feature service's item page in
 AGO, click **Export Data** → **File geodatabase** or
 **Shapefile**. (GeoPackage is also fine if you have a tool that
 produces one.) Wait for the export item.
2. **Download** the resulting file.
3. **Create a data layer in GratisGIS**. From the new-item wizard,
 pick **Data layer**, upload the exported file. The portal
 ingests the schema and features into PostGIS.
4. **Restore symbology** if needed (see "Symbology" below).
5. **Tell anyone referencing the AGO service** to switch their
 map layer to the new data layer item.
6. **Retire the AGO service** when the cutover is done.

### Path B: reference it in place

You're keeping AGO as the source of truth. Use this when you want
to consume the data here without moving it (the AGO portal is
authoritative, or other teams still publish to it).

1. Create an **ArcGIS service** item in GratisGIS pointing at the
 feature service URL.
2. Add it to maps as you would a data layer.

This isn't migration; it's hybrid mode. The data stays at AGO.
See **ArcGIS service** under Items for the full surface.

## What carries over (Path A)

- **Schema.** Field names, types, length, nullable. Coded-value
 domains come in as inline pick lists; if you have one domain
 shared across many feature services, **convert it to a Pick
 list item** first and re-bind on the GratisGIS side.
- **Features.** Geometry, attribute values, attachments (if the
 export format carried them, File Geodatabase does;
 Shapefile doesn't carry attachments).
- **Spatial reference.** Reprojected to EPSG:4326 on ingest
 (PostGIS stores everything geographic; per-map rendering
 projection is independent).

## What does NOT carry over automatically

- **Symbology and labels.** AGO stores these on the **web map**
 layer reference, not on the feature service itself. After Path
 A, the new data layer comes in with default symbology. You'll
 set styles on the GratisGIS side either at the layer level
 (where every map referencing it sees the same default) or
 per-map.
- **Pop-up config.** Same reasoning. Set on the GratisGIS map
 layer reference.
- **Edits-in-flight.** If someone is editing the AGO service
 while you export, that edit won't be in your export. Pick a
 cutover window or freeze the source first.
- **Sharing.** AGO group memberships, organization-level
 permissions, and item-level overrides don't translate. Set
 sharing fresh on the GratisGIS item.

## Symbology

If you want to bring symbology over too, the path is:

1. From AGO, get the **web map JSON** for a web map that uses
 your feature service.
2. On the GratisGIS side, after creating the data layer, open
 the map you want to add it to.
3. Use **Import web map JSON** in the map builder; the importer
 maps AGO renderer types (simple, unique value, class breaks)
 onto GratisGIS symbology types.

See **Web map to map** for the full importer surface.

## Verifying the copy

Before you cut anyone over:

- **Feature count.** Compare AGO's count to the new data layer's
 row count. They should match exactly.
- **Spot-check geometry.** Open the new data layer on a map and
 verify a known feature is in the right place.
- **Spot-check attributes.** Open a row in the feature browser,
 confirm field values match AGO.

## See also

- **Data layer**. The native item type docs.
- **ArcGIS service**. The Path B reference-in-place item.
- **Web map to map**. Importing the AGO web map JSON.
