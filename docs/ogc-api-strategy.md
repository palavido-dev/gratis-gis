# OGC API strategy

Phase 8.5 of the roadmap promotes "OGC API conformance" from a
nice-to-have to a project driver. This doc captures the conformance
targets, the URL + collection-ID contract, and the policies that the
four OGC API classes (Features, Tiles, Styles, Records) will share, so
implementers don't have to re-litigate each design choice per class.

The objective is mechanical: the more of the OGC API surface we ship,
the smaller the custom code path inside the QGIS plugin (and any other
standards-aware client) has to be. Each class landed here deletes
features from `gratis-gis-qgis`.

## What's in scope for v1

Four classes, ordered as the roadmap lists them:

| Class    | Roadmap | Today                  | Target |
| -------- | ------- | ---------------------- | ------ |
| Features | #114    | Core + GeoJSON minimum | Full Part 1 polish |
| Tiles    | #113    | Not started            | Part 1 Core |
| Styles   | #115    | Not started            | Part 1 Core, MapLibre profile |
| Records  | #116    | Legacy CSW only        | Part 1 Core, deprecates CSW |

Out of scope for v1: OGC API - Maps (deferred per ROADMAP §8.5),
Processes (no obvious portal feature maps onto job semantics yet),
Coverages, and Environmental Data Retrieval.

## URL roots

Everything OGC lives under `/api/public/ogc/`. That root is reachable
by anonymous callers (matches the rest of `/api/public/`); per-user
gated content uses the regular `/api/items` surface. Class-specific
sub-paths:

- `/api/public/ogc/` - landing page (the OGC API root document)
- `/api/public/ogc/conformance` - conformance class declaration
- `/api/public/ogc/api` - OpenAPI 3.0 description
- `/api/public/ogc/collections` - Features + (re-used by Tiles)
- `/api/public/ogc/collections/{collectionId}` - one collection
- `/api/public/ogc/collections/{collectionId}/items` - Features
- `/api/public/ogc/collections/{collectionId}/items/{featureId}`
- `/api/public/ogc/tileMatrixSets` - Tiles registry
- `/api/public/ogc/tileMatrixSets/{tmsId}` - one TMS
- `/api/public/ogc/collections/{collectionId}/tiles` - tilesets list
- `/api/public/ogc/collections/{collectionId}/tiles/{tmsId}` - tileset
- `/api/public/ogc/collections/{collectionId}/tiles/{tmsId}/{tileMatrix}/{tileRow}/{tileCol}` - tile
  (OGC names: tileMatrix is the zoom band, tileRow is Y, tileCol is X.
  This doc previously said `{z}/{x}/{y}`, which reversed row and
  column; the code has always used the OGC order.)
- `/api/public/ogc/styles` - Styles list
- `/api/public/ogc/styles/{styleId}` - one style
- `/api/public/ogc/styles/{styleId}/metadata`
- `/api/public/ogc/records` - Records (catalog)
- `/api/public/ogc/records/{recordId}` - one record

The legacy `/api/public/csw/` surface stays up alongside Records
indefinitely; CSW clients (older harvesters, geoportal aggregators)
don't speak OGC API Records yet and removing CSW would break them.
Records is the new front door; CSW is the back door we keep open.

## Collection ID scheme

A `data_layer` v3 item can hold multiple layers (one PostGIS table
per layer key). OGC API Features expects one collection to mean one
feature class, so multi-layer items can't surface as a single
collection without lying about the schema.

The scheme: each layer in a multi-layer item gets its own collection
identified by `<itemId>__<layerKey>` (double underscore separator).
Single-layer items keep using `<itemId>` directly as the collection
ID so existing integrators don't break.

Disambiguation:

- A collection ID matching `^[0-9a-f-]{36}$` (a bare UUID) refers to
  the item's first/only layer (the v1 behavior).
- A collection ID matching `^[0-9a-f-]{36}__[A-Za-z0-9_-]+$` refers
  to the named layer inside the multi-layer item.
- Any other shape: 404.

The first form is preserved as a back-compat alias on multi-layer
items: it always resolves to the first layer (same as today). New
integrations should prefer the explicit `<itemId>__<layerKey>` form.

`__` was chosen as the separator because:
- UUIDs use only `0-9a-f-`, so `__` can't appear inside the item id.
- Layer keys are alphanumeric + `-` + `_` (the v3 layer-key
  validator), but never contain `__` adjacent. The validator will be
  tightened to forbid `__` substring as part of this work.
- `:` and `/` would be parsed by URL routers as separators; `.`
  collides with format suffix conventions.

## CRS policy

Storage CRS is WGS84 lon/lat (EPSG:4326) for everything we own.
OGC API exposes both:

- `http://www.opengis.net/def/crs/OGC/1.3/CRS84` (CRS84, lon/lat,
  axis order x/y) - the default OGC API representation.
- `http://www.opengis.net/def/crs/EPSG/0/4326` (EPSG:4326, lat/lon,
  axis order y/x) - for clients that explicitly request it via the
  `crs` query parameter.

We advertise the CRS conformance class
(`http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/crs`) and
support the `crs` and `bbox-crs` query parameters. Reprojection
beyond axis-order swap is out of scope for v1; clients that need
projected output can post-process.

WebMercatorQuad (EPSG:3857) is the only TileMatrixSet advertised
under Tiles, matching the basemap rendering pipeline.

## Error envelope

All OGC API endpoints return errors as RFC 7807
`application/problem+json` documents:

```json
{
  "type": "https://gratisgis.org/errors/collection-not-found",
  "title": "Collection not found",
  "status": 404,
  "detail": "No public collection with id 'foo'.",
  "instance": "/api/public/ogc/collections/foo"
}
```

The portal's existing Nest exception filters return plain JSON with
a `message` field; the OGC controllers route through a
`ProblemJsonFilter` that reshapes thrown `HttpException`s into the
RFC 7807 form when the request path starts with `/api/public/ogc/`.

## Access scope

All OGC API endpoints are anonymous-reachable and only see items
whose `access` field is `public`. Per-user authentication promotes
the same endpoints later (a signed-in caller would see their own
`org`-scoped items too) but the v1 contract is "OGC API == public
surface only," matching CSW and the existing
`/api/public/ogc/collections` behavior.

When a tile or feature is gated behind a `share_geo_limit` polygon
(see `docs/sharing-granularity.md`), the geo limit is enforced as
if the caller were anonymous (no extra scope from the share). v1
does not promote per-share OGC access; clients that need that
should use the per-user `/api/items` surface.

## OpenAPI 3.0

The OpenAPI 3.0 conformance class
(`http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30`)
requires us to publish an OpenAPI 3.0 document at
`/api/public/ogc/api`. The document is generated at request time
from the running controller's metadata so it stays in sync without a
manual checked-in spec drifting.

We don't auto-generate the OpenAPI through Nest's `@nestjs/swagger`
plumbing for this surface; the OGC document has a specific shape
(security schemes, parameter naming, conformance-class
cross-references) that Nest's generator won't produce verbatim. A
small hand-written generator keeps the OGC document compliant.

## Versioning

The portal does not version the OGC API surface in the URL. Backward-
compatible changes (new conformance classes, new optional query
parameters, new fields in response documents) land additively.
Breaking changes are routed through a parallel path
(`/api/public/ogc/v2/` if it ever happens) so a client built against
v1 keeps working until it migrates explicitly.

The roadmap doesn't anticipate a v2 within the planning horizon. OGC
API specs themselves are designed for additive evolution, which
matches the portal's needs.

## Cross-cutting decisions baked in

- **Time-travel.** The bitemporal "as-of" parameter (`?at=<ISO>`)
  exposed on the portal's internal `/api/items/:id/layers/...`
  surface is NOT exposed on OGC API endpoints. OGC clients expect
  "current truth"; we don't surface the observation log through this
  door. Authors who need historical access use the portal directly.
- **Filtering.** CQL2 Text + JSON
  (`http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter`)
  is target for v2; v1 ships Core + Sortby + CRS only. Clients that
  need filter today use bbox + post-process.
- **JSON-FG.** Out of scope for v1; the GeoJSON conformance class
  covers the realistic interop floor. JSON-FG is on the list for the
  next planning cycle alongside Filter.
- **Coverage / Maps / Processes.** Out of scope as noted above.

## Implementation note for class implementers

Each class lands as its own NestJS controller under
`apps/portal-api/src/public/ogc/`. The existing
`public-ogc.controller.ts` will move there and split per class once
the second class lands; v1 keeps it in place to avoid an empty
refactor commit.

Conformance declarations are appended to the single
`/conformance` endpoint as each class ships. The same goes for the
landing page links: each new class adds a `rel="..."` link rather
than rewriting the landing document.

See also: `docs/feature-services.md`, `docs/sharing-granularity.md`,
`docs/handoff/qgis-plugin-cross-ref-2026-05-20.md`.
