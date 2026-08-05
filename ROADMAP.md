# GratisGIS Roadmap

> **Historical planning document** (note added 2026-07-26). Phase
> statuses below drift as work lands and are not continuously
> re-audited; treat them as a record of intent. For what actually
> ships today, the Status section in [README.md](./README.md) is
> the source of truth.

A phased delivery plan. Each phase is intended to be independently useful and
demo-able; phases intentionally build on one another.

---

## Phase 0: Scaffolding ✅

- [x] Project charter, architecture, roadmap
- [x] Monorepo (pnpm + Turborepo)
- [x] Docker-compose infra (Postgres/PostGIS, Keycloak, MinIO, pg\_tileserv)
- [x] Shared packages skeleton
- [x] CI pipeline
- [x] Local dev loop: `pnpm dev` brings up everything

## Phase 1: Portal MVP (pillar 1) ✅

Goal: a usable portal with auth, items, and sharing. This is the bedrock.

- [x] Keycloak realm + JWT verification in portal-api
- [x] Prisma schema for users, groups, items, item\_shares, orgs
- [x] `/users/me`, `/groups`, `/items` REST endpoints
- [x] Sharing permission checks (private → groups → org → public)
- [x] portal-web: sign-in, my items, item detail, sharing UI
- [x] Group management UI (create group, invite, roles)
- [x] Search + filter on items
- [x] Folders (multi-membership) + smart folders
- [x] Soft delete + trash + cascade-revert
- [x] Per-user capability overrides + admin housekeeping dashboard

**Status:** shipped. Two users in two groups can each create items, share
with their group, and see each other's shared items but not private ones.
Ownership reassignment, time-bounded shares, and folder cascade are all in.

## Phase 2: Web Maps (pillar 2) ✅

- [x] Data layer endpoint backed by PostGIS (multi-sublayer v3 model)
- [x] Upload GeoJSON / Shapefile / GeoPackage / GDB / KML → creates a
      data\_layer item
- [x] pg\_tileserv integration with per-layer permission proxy
- [x] Map item type (basemap + layer refs + styling)
- [x] Map viewer in portal-web using MapLibre GL
- [x] Map authoring UI (Add Layer dialog, simple + unique-values +
      class-breaks renderers, popups, scale visibility, labels)
- [x] Per-share row scope (`all` / `own`) and geographic clip (polygon)
- [x] Per-layer access matrix on web maps (override item-level sharing
      down, never up)
- [x] Editor item type with right-docked AGO-style edit pane
- [x] WebMap JSON export (`GET /items/:id/web-map.json`) for ArcGIS Pro,
      AGO, QGIS, kepler.gl

## Phase 3: Form Designer + Data Collection (pillar 4) ✅

This is the highest-differentiation pillar. We consolidated survey-based
data collection and field geometry capture into one experience.

- [x] Form-builder UI in portal-web (`/forms/[id]`)
- [x] `packages/form-schema` finalized
- [x] Form runtime in portal-web + field PWA (single shared renderer)
- [x] Field PWA (Next.js): browse items, download offline, fill forms,
      capture points/lines/polygons, photo / sketch / barcode / video /
      audio capture
- [x] Per-edit queue + selective retry (a bad row doesn't poison the rest)
- [x] Submissions stored in PostGIS (paired data\_layer per form,
      schema-version-aware)
- [x] Schema-break notifications fan out to deployment owners + field
      downloaders before next sync

## Phase 4: App Builder (pillar 3) ✅

- [x] Web-app template framework (Editor / Viewer / Survey templates)
- [x] Convert-to-Custom escape hatch
- [x] Custom-app grid runtime (24-column CSS grid + per-widget
      renderers; 18 widget kinds: map / legend / layer-list /
      attribute-table / text / chart / search / print / select /
      basemap-gallery / image / button / divider / embed / bookmark /
      coordinates / my-location / tabs)
- [x] Drag-drop visual designer for the Custom template (three-pane
      layout: palette / canvas / inspector; native HTML5 DnD with
      `x-widget-kind` MIME, drag-place + resize gestures, tabs
      drop routing, auto-bind on drop)
- [x] Chart widget (Recharts; bar / line / pie with count / sum /
      avg / min / max aggregates over the bound target)
- [x] Per-widget tool-mode rendering (icon button + popover panel
      for map-following widgets like layer-list, search, select)

**Status:** shipped. A 3-widget app (map + layer-list + chart)
against a data layer takes minutes to author and publishes via
the existing item-share + access flow. Possible follow-ups
(none of these are gating v1):
- Cross-widget filtering (clicking a chart slice filters the
  bound map; clicking a row in the attribute table flies the
  bound map). The plumbing is there per-widget; what's missing
  is a shared "current selection" context that propagates.
- Multi-page app navigation chrome (today the runtime renders
  page[0]; the schema already supports multi-page).
- Theme tokens beyond accent + background.

## Phase 5: Reports + Dashboards (pillar 5) 🟦 not started

The `report_template` and `dashboard` item types exist in the
ITEM_TYPES list but neither has a `Data` shape, a detail page,
a runtime, or any rendering surface yet. A user creating one
gets the generic "coming soon" placeholder.

- [ ] Report template item type (markup + placeholders + chart
      specs). Needs a `ReportTemplateData` shape in
      `packages/shared-types`, a designer page in portal-web,
      and a runtime that walks the template against real data.
- [ ] Report runner (render to HTML, PDF, docx). Realistic
      stack: a server-side renderer using something like
      Puppeteer-PDF for PDF, mammoth + docx-templater for docx,
      and a static HTML emit for the cheap path.
- [ ] Scheduled report delivery via email. The
      scheduled-tasks framework + notifications platform are in
      place; what's missing is a "render-and-email-report" job
      type that consumes a `report_template` item.
- [ ] Dashboard item type (live charts over feature data). The
      Custom Web App template covers most of the
      "single-page dashboard" use case today (Map + Chart +
      AttributeTable widgets in a grid); the gap is a
      *named* dashboard surface with a refresh policy and the
      ability to embed in a portal homepage.

**Decision pending:** does Dashboard live as a separate item
type, or as a Custom-app preset with stricter chrome? The
Custom-app runtime already handles the visual surface; a thin
"this is a dashboard" wrapper that refuses non-display widgets
+ defaults a refresh interval may be the smallest possible
shape.

## Phase 6: Tool & Widget Builder (pillar 6) 🟨 partial

The derived-layer pillar half is solid. Updated 2026-07-26: tool
items now ship a recipe editor and a server-side recipe runner
(`apps/portal-web/src/app/items/[id]/tool/` and
`apps/portal-api/src/tools/`); the React Flow node-graph builder
described in `docs/tool-builder.md` remains future work.

- [x] Derived-layer item type (chained PostGIS spatial pipelines)
- [x] Tool catalog: buffer, centroid, convex-hull, dissolve, fishnet,
      simplify, densify, vertices, calculate-geometry, nearest-neighbor,
      random-sample, top-n, bbox (~300 lines per tool, all engine-
      backed via the v3 cutover)
- [ ] `apps/tool-builder`: React Flow node-graph canvas. New app
      workspace; not started. The design doc has the node
      taxonomy worked out; what's missing is the React Flow UI +
      a `tool` item-type editor + the typed-port plumbing.
- [ ] `apps/tool-runner`: server-side executor. New app workspace;
      not started. The expected pattern is a worker that picks
      jobs off a queue, materialises the node graph into a series
      of PostGIS / turf.js / HTTP-fetch operations, and writes
      results back as a new `derived_layer` or `data_layer`.
- [ ] Tools as draggable widgets in the App Builder. Adds a
      `tool-runner-button` widget kind to CustomWidgetKind that
      points at a `tool` item; clicking the widget triggers a
      run (with the user's auth) and surfaces progress + the
      output reference in a sibling widget.

**Decision pending:** how much of the "general node-graph
executor" actually needs to exist for v1? The derived-layer
pipelines already cover the most common spatial workflows
(buffer + intersect, dissolve, fishnet, etc.) and they're
authored through the derived-layer item's existing form-shaped
editor. The argument for shipping a full tool-builder is "users
want to chain non-spatial steps too" (HTTP fetch, attribute
joins, conditional branches). The argument against is "that's
v2 territory; ship the pillar through derived-layers and revisit
when real workflows need it."

## Engine Substrate (foundational, ✅)

Cross-cutting work that underpins every pillar. Landed alongside Phase 4 / 6
in pre-v1.

- [x] Observation-log table + bitemporal model (Phase 1, migration
      `20260507120000_engine_observation_log`)
- [x] Engine adapter for data\_layer reads + writes (Phase 2.1 / 2.2)
- [x] V3TablesService rewires through engine (Phase 2.4)
- [x] DerivedLayersService source-read through engine (Phase 2.7)
- [x] Stop creating per-layer fs\_ tables; engine owns scope (Phase 2.5)
- [x] Backfill + drop legacy fs\_ tables (Phase 2.6a migration)
- [x] Module rename `features-v3 → data-layer` (Phase 2.6b)
- [x] Lens type + Esri WebMap JSON converter (Phase 3)
- [x] WebMap endpoint at API boundary (`GET /items/:id/web-map.json`)
- [x] Cedar policy engine wired (`@cedar-policy/cedar-wasm`); SharingService
      delegates canRead / canEdit / canDownload / canAdmin to PolicyService
      (Cedar Phase A + B)
- [x] Cedar Phase C: lens-level custom policies (`LensPolicyService`).
      Geometry predicates work via a pre-resolved `Set<string>` on the
      Feature entity since Cedar's WASM ships no geometry extension;
      callers compute spatial containment in PostGIS upstream and hand
      the engine a string-keyed set the policy checks via `.contains(...)`.
- [x] Cedar Phase D: row-level filter wired into
      `DataLayerEngine.listFeatures`. Lens with policy text
      filters its read output; lens without is a passthrough
      (no Cedar invocation, Phase B speed).
- [x] WebMap JSON import (reverse direction):
      `POST /items/web-map-json:import` walks an Esri WebMap,
      classifies each operationalLayer URL, builds a portal `map`
      item with one MapLayer per recognised source.

## Phase 7: (removed)

Reserved for a future phase. The original Phase 7 (hosted notebooks)
was dropped from scope; the "tool" item type covers reusable
computation inside the portal, and external clients reach the data
API with a personal API key (Profile -> API keys) from whatever
environment they already run.

That leaves server-side SCHEDULED execution as the one capability
hosted notebooks would have provided and nothing else does. It is
tracked as its own issue rather than a phase, and deliberately does
not bring a browser IDE with it.

## Phase 8.5: OGC API breadth 🟩 largely landed

Goal: widen the OGC API surface so QGIS, GDAL/ogr2ogr, OpenLayers,
MapTiler, leafmap, and other standards-aware tooling can consume the
portal without bespoke connectors. Updated 2026-07-26: Features,
Tiles, Styles, and Records controllers now ship under
`apps/portal-api/src/public/ogc/` (plus legacy CSW 2.0.2 for
metadata harvest); the checklist below predates that work.

Treat OGC API conformance as an underlying driver: anywhere a new
public surface can be shaped to match an OGC API standard at low
extra cost, the OGC shape wins. This also collapses scope on the
companion `gratis-gis-qgis` plugin -- every OGC API endpoint we
ship is a custom plugin code path we don't need to write or
maintain.

- [ ] **OGC API - Tiles (Part 1).** Wrap the existing PMTiles /
      MVT tile serving in the standard tileset / collection /
      tileMatrixSet endpoints. Highest leverage of the bunch:
      drops every OGC API client onto our basemaps and vector
      tiles drag-and-drop. Probably 2-3 days.
- [ ] **OGC API - Features polish.** Advertise more conformance
      classes (OpenAPI 3.0, CRS, Filter, Sortby), ship an OpenAPI
      document at `/api/public/ogc/api`, surface multi-layer
      data\_layer items as separate collections via the
      `<itemId>__<layerKey>` scheme, support CQL2 filter
      expressions. ~1-2 days.
- [ ] **OGC API - Styles.** Serve MapLibre style JSON per layer
      under the standard `/styles` endpoints so third-party
      renderers can fetch our symbology directly. ~1 day given
      the StyleEditor already produces JSON-serializable styles.
- [ ] **OGC API - Records.** Replace or supplement the legacy
      CSW + DCAT catalog with the modern standard. Mostly a
      shape-translation of the existing catalog feed. Medium
      effort.
- [ ] **OGC API - Maps (deferred).** Lower priority once Tiles
      ships; revisit if anyone asks for server-rendered map
      images.
- [ ] **OGC API - Processes / Coverages / EDR (out of scope
      for v1).** Too specialized + heavyweight for the current
      audience. Revisit only if a concrete consumer surfaces.

---

## Phase 8: Hardening

- [x] **`pg_partman` monthly partitioning of the `observation` table.**
      Landed 2026-05-08 (migration
      `20260508081000_partition_observation_table`). The infra
      postgres image extends `postgis/postgis:16-3.4` with
      `postgresql-16-partman`; the migration installs the extension,
      renames the unpartitioned table out of the way, recreates
      `observation` with composite `(id, tx_time)` PK partitioned
      by range on `tx_time`, registers it with pg_partman (monthly
      interval, premake=24, retention=NULL), copies the existing
      rows into the appropriate month partitions, and drops the
      old table. Future-partition rollover and old-partition
      pruning run via `partman.run_maintenance_proc()`; v1 doesn't
      schedule that yet because the 24-month premake covers two
      years of forward writes -- wire a daily cron via the
      existing scheduled-tasks framework before the trailing edge
      approaches.
- [ ] Verify Postgres page-level checksums are enabled on the prod
      cluster. The engine concentrates feature data into one table,
      so page checksums are now load-bearing for catastrophic-
      corruption detection. Adding to an existing cluster requires a
      `pg_checksums --enable` pass, which is offline.
- [x] AuthZ policy tests. ~55 tests across `policy.service.spec.ts`,
      `lens-policy.service.spec.ts`, and `sharing.service.spec.ts`
      cover every default-policy branch + lens-level forbids
      (attribute, spatial-set, multi-clause stack, parse error,
      forbid-trumps-permit). Phase B pinned the 50 minimum;
      we're past it.
- [x] Backup / restore tooling: `apps/portal-api/src/backup/`
      ships scheduled runs (daily / weekly / monthly / custom
      cron), retention policy, archive manifests, a maintenance-
      mode gate, and admin restore flow. HA story is the future
      work item if we ever multi-host.
- [ ] Load tests for tile serving. The pg_tileserv path is
      unbenchmarked under realistic concurrency. Target: 100+
      concurrent tile fetches against a 100k-feature data\_layer
      with the cell index path engaged. No tooling yet; would
      use k6 or vegeta against `/api/portal/items/:id/tiles/...`.
- [ ] Migration guides from common cloud-GIS export formats. AGO
      and ArcGIS Pro export to Esri WebMap JSON; the
      `POST /items/web-map-json:import` endpoint already covers
      the runtime side. Missing is a step-by-step how-to in
      `docs/migration/from-arcgis-online.md` and equivalents
      for shapefile zip / GeoPackage / KML bulk import (the
      ingest controller handles each format individually but
      we don't document the full migration story).

---

## Milestone Cadence

Original solo-developer estimates (now historical):

| Phase | Duration |
| --- | --- |
| 0 – Scaffolding | 1–2 weeks |
| 1 – Portal MVP | 4–6 weeks |
| 2 – Web Maps | 4–6 weeks |
| 3 – Forms + Field App | 8–12 weeks |
| 4 – App Builder | 6–10 weeks |
| 5 – Reports + Dashboards | 4–6 weeks |
| 6 – Tools | 6–10 weeks |
| Engine substrate | (rolled into 2 / 6) |

Solo effort actuals are roughly tracking the higher end of these ranges with
the engine substrate work pulled in alongside the user-facing phases. Each
phase boundary is defined so the ship brings real value even if the next
phase slips.
