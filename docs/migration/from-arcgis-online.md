# Migrating from ArcGIS Online to GratisGIS

A practical step-by-step for an AGO admin moving content into a
self-hosted GratisGIS portal. Covers what GratisGIS supports, what
to export from AGO, how to import, what survives the round-trip,
and what doesn't.

> **Status:** GratisGIS is a self-hosted portal, a field PWA, and
> a QGIS plugin. Credible today for portal, sharing, field
> collection, and QGIS. It is not a full ArcGIS Online
> replacement. WebMap JSON import keeps FeatureServer URLs as
> live references and does not copy features. Admins can copy a
> hosted feature service into a portal data layer from Admin,
> Migrations, From ArcGIS Online. That same run rewrites web maps
> onto those layers. The importer skips apps, dashboards, and
> forms. File upload of an exported geodatabase or shapefile is
> still a valid copy path. This guide has not been re-checked
> against a live ArcGIS Online org on this pass.

## Quick reference: what maps where

| ArcGIS Online concept | GratisGIS equivalent | Import path |
| --- | --- | --- |
| Web Map | `map` item | POST `/items/web-map-json:import` (this guide) |
| Hosted Feature Layer | `data_layer` item | From ArcGIS Online importer (copies features), or a file upload (see below) |
| Hosted Tile Layer | `basemap` item OR `data_layer` ingested as features | Manual; AGO tile services don't export |
| Service URL (Living Atlas etc.) | Connected service (`service` item) | Paste URL in the new-item wizard. Older rows may still be `arcgis_service`. |
| Group | `group` (one-for-one) | Manual recreation; no bulk import yet |
| Sharing settings | `item_share` rows + `access` field on each item | Per-item; cascade through folders |
| Folder | `folder` item with `childItemIds` | Manual recreation; bulk folder import is a v2 candidate |
| Symbology / popups | `MapData.layers[].style` + `popup` | Comes through WebMap import; usually needs an admin polish |
| Scheduled exports / reports | (deferred to v1.1) | -- |

## Step 0: inventory and decide what comes across

Not everything from your AGO org needs to come across. Skim the
inventory and decide:

- **Datasets you actively use** -> export and import.
- **Datasets you reference but don't own** (Living Atlas
  basemaps, third-party services) -> add as `arcgis_service`
  items pointing at the same URL. No data copy; the portal
  proxies the request.
- **Stale / unused datasets** -> leave behind. v1 is a good
  forcing function to retire what you weren't actually using.
- **Apps built in Web AppBuilder / Experience Builder** -> AGO
  does not export these to a portable format. The ArcGIS Online
  importer skips them. A nearby surface is a GratisGIS web app.
  It is not a drop-in, and the widget set is not the same.

## Step 1: export your data layers from AGO

For each Hosted Feature Layer you want to migrate:

1. Open the item detail page in AGO.
2. Click **Export Data** -> **Export to GeoJSON** (or **File
   Geodatabase** / **Shapefile** if you prefer).
3. AGO emails you a link when the export is ready (usually a
   few seconds).
4. Download the file.

Three format options worth knowing about:

- **GeoJSON** is the cleanest round-trip; coordinates are
  EPSG:4326 already, attributes are typed JSON, no driver
  ambiguity. **Recommended for layer counts under ~100k
  features.**
- **File Geodatabase (.zip)** preserves Esri-side typing more
  precisely (date/time precision, domain-coded values, M/Z
  values on geometries). GratisGIS reads .gdb via the GDAL
  OpenFileGDB driver. Use for large or domain-heavy layers.
- **Shapefile (.zip)** is widely supported but has known field-
  truncation gotchas: column names cap at 10 chars and string
  values cap at 254 chars. Avoid unless the source data is
  already shapefile-shaped.

## Step 2: import each data layer

The GratisGIS new-item wizard (Items list -> **+ New** ->
**Data layer**) has an **Import** tab that takes the file you
downloaded:

1. Drag the GeoJSON / GDB.zip / Shapefile.zip onto the upload
   area.
2. The wizard probes the file with GDAL and shows a per-layer
   summary: name, geometry type, fields, and feature count.
3. For multi-layer files (GDB, Shapefile zip with several .shp),
   pick which sublayers to bring across and confirm field types.
   Each sublayer becomes one sublayer of the new `data_layer`
   item.
4. Click **Create**. Ingest runs server-side; the wizard
   navigates to the new item's detail page when it's done.

What to expect:

- **Coordinate system:** GratisGIS stores everything in
  EPSG:4326. The ingest pipeline reprojects from the source SRS
  via GDAL. You don't need to convert ahead of time.
- **Field types:** GratisGIS supports `string`, `number`,
  `boolean`, `date`, plus a `pick_list` reference for coded-
  value domains. AGO domain-coded fields come across as plain
  string columns by default; to attach a real pick list,
  create a `pick_list` item and reference it from the field
  (Items list -> **+ New** -> **Pick list**).
- **M / Z values on geometry:** dropped. GratisGIS stores 2D
  geometry only. If your workflow depends on M-aware analysis,
  open an issue.
- **Attachments:** AGO attachments don't export through the
  standard data export. v1 GratisGIS supports per-feature
  attachments via the upload-during-edit flow, but bulk
  migration of existing AGO attachments is a manual ETL
  exercise today.

## Step 3: import your web maps

For each AGO Web Map you want to migrate:

1. Open the Web Map's item detail in AGO.
2. URL pattern: `https://www.arcgis.com/home/item.html?id=<UUID>`
3. Append `&f=json` to the URL and load it. AGO returns the raw
   item JSON (or a thin wrapper around it).
4. Inside that JSON, find the `data` field. That's the
   WebMapJSON.
5. Save it to a file: `web-map-export.json`.

Then post it to GratisGIS:

```bash
curl -X POST \
  -H "Authorization: Bearer $YOUR_PORTAL_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @web-map-export.json \
  "https://your-portal.example.org/api/portal/items/web-map-json:import"
```

The endpoint expects the body to be `{ "webMap": <the WebMap
JSON>, "title": "..." }` -- wrap your downloaded JSON in that
envelope:

```bash
jq -n --slurpfile wm web-map-export.json \
  '{ webMap: $wm[0], title: "Migrated parcels map" }' \
  | curl -X POST \
      -H "Authorization: Bearer $YOUR_PORTAL_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "https://your-portal.example.org/api/portal/items/web-map-json:import"
```

Response shape:

```json
{
  "itemId": "11111111-2222-3333-4444-555555555555",
  "warnings": [
    "Layer \"Old roads\" URL was unrecognised (https://...); skipped."
  ],
  "layerCount": 4,
  "skippedLayerCount": 1
}
```

The new map item is in your private space (`access: private`).
Open it from the Items list, verify everything looks right,
share it, then trash it if anything went sideways and re-import.

What survives the round-trip:

- Layer references to **portal-internal data layers**
  (those you imported in Step 2). The resolver matches the AGO
  Hosted Feature Layer URL against your portal's `arcgis_service`
  items first; if a match is found, the new MapLayer
  back-references that item's id. Otherwise it's a
  `kind: 'arcgis-rest'` MapLayer pointing at the original AGO
  URL, which still works as long as the consuming user has AGO
  access.
- Layer references to **external arcgis-rest URLs**: come
  across as `kind: 'arcgis-rest'` MapLayers. The portal proxies
  the request at render time so the consuming user only needs
  GratisGIS auth.
- Layer references to **plain GeoJSON URLs** (.geojson / .json):
  come across as `kind: 'geojson-url'` MapLayers.
- **Map viewport** (center / zoom): preserved. AGO uses
  scale-denominator units; GratisGIS converts to MapLibre zoom
  via `log2(591657550.5 / scale)`, which is the standard
  inverse and accurate to within 1 zoom step.
- **Basemap reference**: matched against your portal's basemap
  items by tile URL. If your AGO map used a basemap whose tile
  URL doesn't match any of your portal's basemap items, the
  import falls back to your org's default basemap and emits a
  warning.
- **Layer titles, opacity, visibility**: preserved on the
  imported MapLayer envelope.
- **Single-clause definition expressions** (`"field" = 'value'`,
  `"field" >= 100`, `"field" IS NULL`, etc.): translated to the
  portal's `MapLayerFilter` shape. Multi-clause expressions
  (`"a" = 1 AND "b" = 2`) emit a warning and the filter is
  dropped on import; the layer renders without the filter and
  you can recreate it manually.

What gets warnings (caller decides what to do):

- Unsupported layer types: WebTiledLayer, GroupLayer, raster
  layers. Skipped with a warning.
- Multi-clause `definitionExpression`: dropped, warned.
- Operational layers without a usable URL: skipped, warned.

What doesn't survive:

- **Symbology renderers** (unique-values, class-breaks): import
  uses the portal's default `simple` renderer. Polish per-layer
  symbology in the GratisGIS map editor after import.
- **Popup configuration**: import uses the portal's default
  popup (every visible field). Customize per-layer in the
  popup editor.
- **Labels**: import disables labels by default. Re-enable +
  configure per-layer.
- **Time-aware layer settings**: not modeled. The portal has a
  `?asOf=` query parameter on the engine read path
  (bitemporal time-travel) that's a different mental model;
  see `docs/architecture/observation-log-engine.md`.
- **Bookmarks / scale-dependent visibility**: not yet imported,
  even though the portal's MapLayer schema supports both. Worth
  adding if real users miss it.

## Step 4: rebuild apps

Web AppBuilder / Experience Builder apps don't export to a
portable format. Rebuild them in the GratisGIS Custom App
template (Items list -> **+ New** -> **Web app** -> **Custom**).
The widget kit overlaps closely with EB's; the designer is
drag-drop. See `docs/web-app-templates.md` for the widget catalog
and binding patterns.

If your AGO apps were Esri-template-based (Storyteller, Crowdsource
Reporter, etc.), the v1 GratisGIS roadmap doesn't have direct
equivalents -- those land as Custom apps using the building blocks
the runtime exposes today.

## Step 5: dry run, then production cutover

Before pointing real users at the new portal:

1. Import a sample of layers + maps + apps into a staging
   instance.
2. Walk every map and every app. Verify symbology, popups,
   share targets, anonymous access (if you intend public).
3. Open one map in ArcGIS Pro via `Add Data` -> **From URL** ->
   the portal's `/items/<map-id>/web-map.json` endpoint to
   confirm the round-trip back into Esri's stack works.
4. Cut DNS / SSO / direct links over to the new portal in a
   maintenance window. Keep the AGO org online for ~30 days as
   a fallback.

## Known pitfalls

- **AGO export takes a few minutes for large layers.** Don't
  refresh the AGO item page; the export jobs are async and the
  download link appears in your inbox separately.
- **Shapefile field truncation is silent.** If your source
  layer has fields longer than 10 chars (e.g.
  `road_classification`), AGO's shapefile export truncates them
  and the imported layer ends up with `road_class` as the
  field name. Use GDB or GeoJSON to avoid this.
- **GeoPackage exports are sometimes mis-formed.** Use the
  GDAL command-line `ogr2ogr -f GeoJSON out.geojson in.gpkg` as
  a workaround if you hit a "couldn't open" error during
  import.
- **Sharing settings don't migrate automatically.** Per-item
  sharing has to be re-applied in GratisGIS after import. The
  portal's housekeeping dashboard surfaces "items with no
  shares" so you can find anything left private by mistake.
- **Domain-coded field values come across as the *codes*, not
  the *labels*.** AGO stores `1`, `2`, `3` in the field with a
  domain that maps those to "Active", "Inactive", "Pending".
  The export embeds the codes. To get labels back, create a
  `pick_list` item with the same code-label pairs and bind the
  field to it; the runtime will then display the label.

## Getting help

If something doesn't work, file a GitHub issue with:

- The source format (GeoJSON / GDB / Shapefile / WebMap JSON).
- The size (rough feature count + file size).
- The exact error message or unexpected behaviour.
- A redacted sample if the source is shareable.

The `POST /items/web-map-json:import` endpoint surfaces
`warnings` for everything it skipped or downgraded. Capture
those in the issue body so the next reviewer knows what
shape the data was in.
