# Feature services

A `data_layer` item holds vector data — points, lines, polygons,
mixed — that can be consumed as a layer source in web maps, as the
target of a form's submissions, or as the body of a dashboard panel.

## Today: inline GeoJSON

v1 stores the feature collection inline in `item.data` as a typed
`DataLayerData` (see `packages/shared-types/src/feature-service.ts`).
That keeps the moving parts to a minimum: one Postgres row per
feature service, one API surface (`GET /api/items/:id/geojson`), one
client-side editor.

Practical cap: ~25 MB uploaded, a few megabytes of parsed JSON in
dataJson. For anything bigger, hold off until the PostGIS path ships.

## Ingest

Users populate a feature service by opening its detail page and using
the **Replace data** panel. Two entry points:

- **Upload file** (default). Drag-drop or file picker. Supported
  formats, all parsed client-side:
  - GeoJSON (`.geojson`, `.json`)
  - KML (`.kml`)
  - KMZ (`.kmz`)
  - Shapefile delivered as a `.zip` containing `.shp`, `.dbf`, `.prj`,
    and optionally `.cpg`/`.shx`. Multi-layer zips are flattened into
    one feature collection.
- **Paste GeoJSON**. For small datasets or clipboard workflows.

After parsing, a staged preview shows the detected format, feature
count, and derived fields with types. Nothing is persisted until the
user clicks **Save replacement**.

Dependencies: `@tmcw/togeojson` for KML, `jszip` for KMZ + zip
sniffing, `shpjs` for shapefiles. All three are dynamically imported
so the default bundle stays small for users who never open the
ingest flow.

### File Geodatabase (.gdb)

Robust `.gdb` parsers live inside GDAL; there is no production-grade
JS equivalent. When the user drops a `.gdb` or `.gdb.zip`, the upload
handler detects it and routes through **server-side GDAL** at
`POST /api/items/:id/ingest`. That endpoint uses `gdal-async` (Node
bindings, ships prebuilt binaries — no system GDAL install required in
dev) to read the uploaded archive via GDAL's `/vsizip/` virtual
filesystem, iterate every layer, emit a merged GeoJSON collection, and
write it straight back to the item.

The same endpoint accepts any OGR-readable format (shapefile, KML,
KMZ, GML, GPX, MapInfo TAB, CSV with WKT, etc.), so advanced users or
scripts can ingest anything the browser parsers don't. The default
client-side flow still handles GeoJSON / KML / KMZ / Shapefile zips
with zero round-trip; server-side only fires when needed.

## Storage roadmap

1. **v1 (here now):** inline GeoJSON in `item.data`. Works for demos,
   reference datasets, and anything in the low-megabytes range.
2. **v2:** persist data in a real PostGIS table per feature service.
   - `item.data` holds only the metadata (field schema, table name,
     bbox, feature count).
   - `GET /api/items/:id/geojson` streams from PostGIS on demand,
     optionally with spatial + attribute query params.
   - `pg_tileserv` (already in the stack) serves vector tiles for the
     map renderer.
   - Background ingest job handles heavy uploads asynchronously.
3. **v3:** versioning, editing, submissions routing from the field
   app. Each feature edit appends to a history table; undo and
   per-field change tracking come for free.

## API

Current:

```
GET    /api/items/:id           envelope (metadata + data)
GET    /api/items/:id/geojson   GeoJSON FeatureCollection only
PATCH  /api/items/:id           replace or partial update of `data`
```

When the PostGIS path ships, `/geojson` gains `?bbox`, `?where`, and
`?limit` params. `PATCH` with a full-collection body becomes one of
several ingest verbs (`POST /:id/features` for append,
`DELETE /:id/features/:fid` for single-feature delete, and so on).

## Web map integration

Web-map layers choose a `feature-service` source and reference an
item id. At render time the canvas passes the `/geojson` URL straight
to MapLibre's geojson source, so authorization passes through the
normal portal proxy and nothing new is invented.
