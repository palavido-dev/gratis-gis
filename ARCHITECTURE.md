# GratisGIS Architecture

This document describes the service topology, boundaries, and cross-cutting
concerns for the GratisGIS platform. It complements `README.md` (what we're
building) and `ROADMAP.md` (when we're building it).

## Design Principles

1. **One-command install.** A small org should go from a fresh VM to a
   working portal in under 30 minutes, with one command. Every architectural
   choice is measured against this bar. We will *not* ship something that
   takes a week of consulting to stand up. See [docs/deployment.md](./docs/deployment.md).
2. **One domain model, everywhere.** The `Item` concept (with owner, sharing,
   and type) is the backbone: web maps, feature collections, forms, web apps,
   and reports are all items. This is a familiar content-portal pattern and
   lets a single portal, sharing, and search layer serve every product.
3. **TypeScript across all surfaces** so form schemas, sharing logic, and
   geometry types can be reused in the API, web portal, app builder, and
   field app.
4. **Offline-first for collection.** The field app treats online as a bonus;
   the sync engine is first-class.
5. **Composable OSS infra.** Identity (Keycloak), storage (MinIO), tiles
   (pg\_tileserv), and geoprocessing are swappable.
6. **Strict service boundaries.** Each app (portal-api, portal-web,
   portal-mcp) is independently deployable; cross-service contracts live in
   `packages/shared-types`.
7. **Sensible defaults > configuration.** Every knob has a good default.
   Admins should never *have* to read a reference manual; they should be
   able to, when they want to tune something.
8. **Polish is a feature.** Every surface (portal, app builder, field app)
   must feel crafted. Dated, "engineer-built" UI is off-brand. See
   [docs/design-system.md](./docs/design-system.md) for the standards
   every app ships against (typography, motion, empty states, a11y,
   loading skeletons, dark mode).

## System Topology

```
            ┌────────────────────────┐
            │    Identity: Keycloak  │  OIDC / JWT
            └──────────┬─────────────┘
                       │
 ┌─────────────┐   ┌───┴───────────┐   ┌────────────────┐
 │ portal-web  │──▶│  portal-api   │──▶│ PostgreSQL 16  │
 │ (Next.js)   │   │  (NestJS)     │   │   + PostGIS 3  │
 └─────────────┘   └───┬───────────┘   └────────────────┘
                       │
                       ├──▶  MinIO (object storage: attachments, uploads)
                       ├──▶  pg_tileserv (vector tiles from PostGIS)
                       │
 ┌─────────────┐       │
 │  field PWA  │───────┘  (served by portal-web at /field; offline
 │ (portal-web)│           caching + queued sync via REST deltas)
 └─────────────┘
```

## Services

### portal-api (NestJS, Node 22)

The single authoritative backend. Exposes REST + JSON; modules:

- `auth/`: Keycloak JWT verification guard, user profile sync,
  per-user capability overrides
- `users/`: `GET /users/me`, org membership
- `groups/`: groups, memberships, roles
- `items/`: CRUD + type-specific payload storage,
  `GET /items/:id/web-map.json` (Esri WebMap export)
- `policy/`: Cedar (`@cedar-policy/cedar-wasm`) policy evaluator;
  `SharingService` delegates canRead / canEdit / canDownload /
  canAdmin to it
- `engine/`: observation-log substrate (append-only feature store,
  bitemporal reads, current-truth projection, lens query planner)
- `data-layer/`: feature CRUD + attachments routed through the
  engine adapter; per-sublayer endpoints
- `derived-layers/`: chained PostGIS spatial pipelines
  (buffer / centroid / dissolve / fishnet / etc.) reading from the
  engine
- `forms/`: form schema items + submission endpoint
  (offline-friendly), paired data\_layer mirror
- `field-queue/`: per-edit retry queue for the field PWA
- `notifications/`: SMTP + per-org template editor
- `backup/`: archive + restore
- `ingest/`: GDAL-driven file → engine ingest

OpenAPI spec is auto-generated and published at `/docs`.

### portal-web (Next.js 16, App Router)

Consumes portal-api. Uses `next-auth` with a Keycloak provider. Server
components do data fetching with the user's JWT forwarded; client
components handle interactive UI (maps, builders).

### portal-mcp (Model Context Protocol server)

A small stdio MCP server that exposes a read-only view of a portal
(list items, get item, read layer features) to MCP clients such as
Claude Desktop and Cursor. Authenticates against portal-api with a
bearer token; sharing and geographic limits are enforced server-side
like any other client. See `apps/portal-mcp/README.md`.

### External data access (read-only API)

Each data layer exposes a read-only REST API gated by personal
access tokens. External clients (VS Code, RStudio, command-line
tools) authenticate with a PAT, request feature data, and let
the server enforce geographic share limits before responding. No
hosted execution environment ships with v1; external tools run
wherever the user runs them.

### tool-builder + tool-runner (future)

`tool-builder` is a React Flow-based authoring app. Users compose a graph of
typed nodes (inputs, spatial ops, SQL steps, HTTP fetches, outputs). The
graph is saved as a `tool` Item.

`tool-runner` is a Node worker service that executes tools. It preferentially
pushes work down to PostgreSQL/PostGIS (most geospatial operations already
exist as SQL) and falls back to turf.js in-process for lightweight vector ops.
Jobs expose status over a REST endpoint and emit progress events via
Server-Sent Events.

Tools can also be exported as drag-and-drop widgets consumable by
`app-builder`. The widget manifest declares the tool's inputs, outputs, and
UI bindings.

See [docs/tool-builder.md](./docs/tool-builder.md).

### Field surface (shipped, part of portal-web)

Data collection ships as an installable PWA inside portal-web (the
`/field` routes), not as a separate native app:

- Browse items shared with you and download deployments for offline use
- Collect features (forms + point/line/polygon capture, photos,
  sketches, barcodes, audio, video)
- Offline caching via a service worker plus an IndexedDB store
  (`sw.js` and `src/lib/offline-*.ts`); queued writes sync when back
  online with per-edit retry, so one bad row cannot poison the batch

The field surface uses the same form renderer as the rest of
portal-web (`src/components/form-runtime.tsx`), so a form authored in
the designer renders identically on desktop and in the field.

### Shared packages

- `packages/engine`: observation-log engine core shared between apps
  (lens types, WebMap JSON conversion)
- `packages/shared-types`. API contracts, enums, branded IDs
- `packages/form-schema`. TypeScript types & JSON Schema for form definitions
- `packages/geo`: (future) geometry helpers, spatial utilities (wraps turf.js)
- `packages/ui`: shared React components (buttons, dialogs, tables)

## Data Model (high-level)

```
Organization 1───* User *───* Group
       │                       │
       └────────── owns ───────┤
                               │
Item *──── ItemShare *── (Group | User | Org | public)
```

`Item.type` is a closed string union of 28 values (map, data_layer,
form, web_app, tool, basemap, point_cloud, ...). The single source of
truth is `ITEM_TYPES` in `packages/shared-types/src/item-types.ts`;
this document deliberately does not duplicate the full list.

See [docs/data-model.md](./docs/data-model.md) for full detail.

## Authentication & Authorization

- Keycloak issues OIDC tokens. `portal-api` verifies signatures using the
  realm's JWKS.
- Each user has an `Organization` scope. Items are owned by a user and
  shared via `ItemShare` rows.
- Sharing scopes follow a familiar portal pattern: `private`,
  `shared-with-group(s)`, `org`, `public`.
- Roles within a group: `member`, `admin`. Org roles: `viewer`,
  `contributor`, `admin`.
- **Authorization runs through Cedar.** `SharingService.canRead /
  canEdit / canDownload / canAdmin` delegate to `PolicyService.check`,
  which evaluates Cedar policy text against a request-scoped entity
  store (User + Org + Item with entity-typed attributes). The default
  policy mirrors the imperative behaviour: owner-permits, org-admin-
  permits, public-read, org-read, plus tiered explicit-share permits
  (view / download / edit). Cedar's forbid-trumps-permit semantics
  let lens-level custom policies *subtract* privilege from the
  platform default in Phase C, never add.

See [docs/auth-model.md](./docs/auth-model.md) for token flow and
claims, and
[docs/architecture/cedar-policy-integration.md](./docs/architecture/cedar-policy-integration.md)
for the policy engine choice + entity model + three-phase rollout.

## Geospatial Storage

All feature data lives in PostGIS. Pre-engine versions of the platform
used per-layer feature tables (`fs_<itemId>_<layerId>`) keyed by the
data\_layer item's id. Post-engine the substrate is a single
append-only `observation` table, scoped by string keys like
`data_layer:<itemId>:<layerId>`. Each row is one create / update /
delete observation; "current truth" is computed at read time as
`DISTINCT ON (entity) ... WHERE valid_to IS NULL AND kind <>
'delete'`. The bitemporal model (`valid_from` / `valid_to` for world
time, `tx_time` for system time) is what gives the platform its
free audit trail and `?asOf=<timestamp>` reads.

Tiles are served by pg\_tileserv with a permission-aware proxy
layer in `portal-api`. The engine emits the same
`global_id / geom / properties` projection the legacy fs\_ tables
exposed, so derived-layer tools and tile generators read it
unchanged.

See
[docs/architecture/observation-log-engine.md](./docs/architecture/observation-log-engine.md)
for the full design.

## Esri WebMap interop

Portal `map` items are consumable by ArcGIS Pro, AGO, QGIS (via the
WebMap importer plugin), and kepler.gl natively through the
`GET /items/:id/web-map.json` endpoint. The endpoint walks the map's
layer list, resolves each layer's source to an engine `Lens` (for
data\_layer / derived\_layer sources) or to a direct
`ArcGISFeatureLayer` (for arcgis\_service / external GeoJSON URLs),
and emits the v1 subset of the Esri WebMap spec. The reverse
direction (importing an Esri WebMap as a portal map item) is shipped
in `packages/engine` (`webMapJsonToLens`) but the bulk-import
controller endpoint is a Phase 8 hardening follow-up.

## Spatial Reference Policy

**Storage is always EPSG:4326 (WGS 84 geographic).** Every PostGIS
geometry column in the portal is declared `GEOMETRY(<type>, 4326)`.
Bounding boxes, geo-limits, and `ST_Intersects` filters all operate
in lat/lng. This is the same convention ArcGIS Online hosted feature
services use, and matches GeoJSON's RFC 7946 implicit CRS.

**Ingest reprojects.** `IngestService` reads every uploaded file's
source SRS via GDAL, builds a `CoordinateTransformation` to 4326,
and applies it in-place before writing rows. The source SRS (as an
`EPSG:NNNN` string) is captured on the item's `source.sourceSrs`
provenance block so consumers can see where the data came from.
Files with no declared SRS are assumed to be 4326; reprojection is a
no-op when the source is already 4326.

**Clients reproject for display.** MapLibre renders 4326 GeoJSON in
Web Mercator (EPSG:3857) on the fly. We never store Web Mercator;
it's purely a rendering concern.

**What the portal does NOT do:**

  - Multi-SRID storage (one canonical SRID keeps the query layer
    simple and avoids transforming at every spatial filter)
  - Per-feature CRS (a feature inherits its layer's declared SRID)
  - Lossless preservation of the source projection through the
    ingest-query cycle (the original SRS is remembered as metadata
    only; features are stored in 4326)

**For callers extending the ingest pipeline:** follow the pattern in
`featureGeomJson()` in `apps/portal-api/src/ingest/ingest.service.ts`.
Read `layer.srs`, build `new gdal.CoordinateTransformation(src,
target4326)`, call `geom.transform(transform)` before `geom.toJSON()`.
PostGIS-side transforms use `ST_Transform`; we use them only for
display endpoints that want Web Mercator tiles, never for writes.

## Offline & Sync

The field PWA stores local state in IndexedDB (a queue of pending
write ops, a per-item feature cache, and per-item sync cursors),
shared between the page and the service worker. Sync uses a pull/push
delta model:

- **Pull**: client passes a `since` cursor; server returns changed features
  and form-submission rows.
- **Push**: client posts a batch of ops (`create`, `update`, `delete`) with a
  client-generated UUID; server reconciles and returns conflicts.

Conflicts are surfaced to the user as merge prompts in the app.

## Build & Deploy

- **Local dev**: `docker-compose up` starts infra; `pnpm dev` starts apps.
- **CI**: GitHub Actions runs lint, typecheck, test, build across workspace.
- **Prod (future)**: Container images pushed to GHCR; deployable via
  Docker Compose (single node) or Kubernetes (scale). No cloud lock-in.

## Non-goals (for now)

- Hosted Jupyter (deferred to v2; v1 ships a read-only data API and
  recommends BYO Jupyter)
- Raster analysis / heavy geoprocessing (addressed by tool-runner once
  Phase 6 lands; we won't build a bespoke geoprocessing engine)
- 3D scene services
- Native desktop client
