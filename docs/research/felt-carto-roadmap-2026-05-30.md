# Felt + CARTO equivalents roadmap

Companion to [`felt-carto-2026-05-30.md`](./felt-carto-2026-05-30.md).
That doc identified the features small teams pay both vendors for and
the gaps neither vendor closes. This doc translates each Tier A and
Tier B takeaway into a concrete plan that sits inside our existing
ecosystem, with the sequencing reasoning and the explicit landing
points in code.

Promoted to first priority on user feedback: the **drawings / redline
primitive**. The Reddit chorus that calls Felt "Figma for maps" is
almost always pointing at this specific use case — a project manager
or non-GIS stakeholder opens a shared map, marks it up, leaves notes,
and ships the markup back to the team. Felt makes that workflow
trivial; in the ArcGIS world it typically requires extra licensing.
It maps cleanly onto our editor pane and shared sharing model and is a
strict prerequisite for the comments-on-features story, so it leads
the sequence.

## Strategic ordering

Eight Felt/CARTO-derived items plus one cross-cutting concern
(multi-language / i18n, item 9). The eight unlock each other in a
specific order; i18n runs as an independent third stream because
its biggest cost is the one-time i18n-readiness pass that benefits
from being done early, before too many more strings get hard-coded.

GitHub issues filed for each item:

- Item 1 — Drawings / redline primitive — [#154](https://github.com/palavido-dev/gratis-gis/issues/154)
- Item 2 — Threaded comments — [#155](https://github.com/palavido-dev/gratis-gis/issues/155)
- Item 3 — Live cursors / presence — [#156](https://github.com/palavido-dev/gratis-gis/issues/156)
- Item 4 — Workflows-style visual DAG — [#157](https://github.com/palavido-dev/gratis-gis/issues/157)
- Item 5 — PostGIS live-read connector — [#158](https://github.com/palavido-dev/gratis-gis/issues/158)
- Item 6 — Print / PDF export — [#159](https://github.com/palavido-dev/gratis-gis/issues/159)
- Item 7 — Smart upload (geocode + geomatch) — [#160](https://github.com/palavido-dev/gratis-gis/issues/160)
- Item 8 — MCP server — [#161](https://github.com/palavido-dev/gratis-gis/issues/161)
- Item 9 — Multi-language / i18n — [#162](https://github.com/palavido-dev/gratis-gis/issues/162)

1. **Drawings primitive** is the wedge for the collaboration story and a
   strict prerequisite for feature-level comments and live cursors.
2. **Threaded comments** sit on top of drawings and on top of map / layer
   / feature surfaces. Independent track once drawings ships.
3. **Live cursors / presence** are the third leg of "Figma for maps."
   Phase 1 (presence) is cheap, Phase 2 (collaborative edits on
   drawings) leans on the drawings primitive.
4. **Workflows DAG** is a generalization of the existing recipe runner.
   Independent track. The single largest engineering lift of the eight
   but the highest CARTO-positioning value per unit of work.
5. **PostGIS live-read connector** is mostly an item-type variant on
   `arcgis_service` plus connection management.
6. **Print / PDF export** is independent; reuses thumbnail-designer
   layout primitives. Demanded constantly; shipped well by neither
   vendor.
7. **Smart upload (geocode + geomatch)** is an enhancement to the
   existing ingest pipeline, not a new system.
8. **MCP server** is a thin facade over the existing tool-runner API.
   Smallest lift, large positioning win: the comparable offerings are
   gated to Enterprise plans.

Sequencing: 1 → 2 → 3 forms the collaboration story and should run as
a single coherent stream. 4 / 5 / 6 / 7 / 8 are independent and can be
parallelized or interleaved. The MCP server is small enough that any
gap day fits it.

---

## 1. Drawings primitive (manager / redline markup) — TOP PRIORITY

### Strategic value

This is the "Figma for maps" feature in five Reddit threads out of
six. The buyer is the non-GIS stakeholder who needs to mark up a map
for a specific review — proposed alignment changes, parcel
corrections, "move this depot 200 ft east," "this sidewalk is wrong
here." Every redline / markup tool we have today in the ArcGIS world
costs a Pro license or a Field Maps subscription. Shipping this
inside the standard portal viewer, on the standard share permission,
is a clear differentiator.

### Design

A drawing is **not** a `data_layer`. A drawing is an ephemeral,
author-owned, per-map markup overlay. Multiple authors can have
distinct drawing sets on the same map, each visible / hidden
independently. Drawing sets carry their own color so two reviewers
are visually distinguishable at a glance. Anyone with VIEW access to
the map can create their own drawing set, even on a publicly shared
map — that's the manager-redline unlock.

Data model (extends `map.data_json`):

```ts
type DrawingSet = {
  id: string;                // uuid
  authorId: string | null;   // null = anonymous public viewer
  authorDisplay: string;     // pre-resolved display name
  title: string;             // 'Review round 2', 'Matt redline 2026-06-01'
  color: string;             // hex; auto-assigned, user-overridable
  visible: boolean;          // default true
  features: GeoJSON.FeatureCollection; // points, lines, polygons, text
  createdAt: string;         // ISO
  updatedAt: string;
};

type MapDataJsonV4 = MapDataJsonV3 & {
  drawings?: DrawingSet[];
};
```

Properties on each drawing feature: `kind` (`pin` | `line` |
`polygon` | `text` | `arrow` | `circle`), `style` (color override,
stroke width, dash, fill opacity), `label` (free text), `comments`
(see #2).

### Landing points in code

- `packages/shared-types/src/map.ts` — extend the map shape with the
  `drawings?: DrawingSet[]` field. Bump `dataJsonVersion`.
- `apps/portal-api/src/items/items.service.ts` — add validation for
  drawings on map update. Anonymous-author writes need the same
  rate-limit treatment we use for public tool-run.
- `apps/portal-api/src/items/maps.controller.ts` (new endpoints, not
  a full rewrite): `POST /items/:id/drawings` (create my drawing set),
  `PATCH /items/:id/drawings/:drawingId` (update my own set; admin can
  update anyone's), `DELETE /items/:id/drawings/:drawingId`.
- `apps/portal-web/src/app/items/[id]/tool/` — extend the editor pane
  with a Markup tab. Toolbar entries already exist for the geometry
  primitives from the OSM tool work; the rendering and editing logic
  is reusable.
- `apps/portal-web/src/components/map/map-renderer.tsx` (or wherever
  MapLibre style assembly lives) — drawings render as a final overlay
  layer above all data layers, above all derived layers, below
  attribution and scale bar.

### Phases

- **Phase 1 — viewer-side draw + share.** Anyone with view access can
  add a drawing set, see their own, see others'. Drawings persist on
  the map item. No comments yet. UI: Markup tab in the editor pane,
  list of drawing sets with show/hide toggles. Export: drawing set as
  GeoJSON.
- **Phase 2 — promote to data layer.** Right-click on a drawing set →
  "Save as data layer." Creates a real `data_layer` from the GeoJSON
  with the user as owner.
- **Phase 3 — print integration.** Drawings render in the print/PDF
  output (see #6).

### Dependencies

None. Strictly first.

### Effort

Medium. Phase 1 is the bulk; existing editor pane gets a new tab and
existing geometry-edit primitives get a new write path.

### Success criteria

- A logged-in viewer of a public map can add a redline drawing set
  and a different logged-in viewer sees it on next load.
- An admin can delete any drawing set; a viewer can only delete their
  own.
- A drawing set exports as GeoJSON via a direct link.
- Drawings survive a map item update from the layer-editing UI without
  being silently overwritten.

### Open questions

- Anonymous public viewer markups: allow them, behind rate-limit and
  optional captcha? Initial answer: yes, behind the public-tool-run
  rate-limit pattern, captcha optional per-map.
- Per-drawing-set sharing model: are drawings visible to all map
  viewers by default, or only to people in the same workspace? Initial
  answer: visible to all viewers, with a per-set "private to me"
  toggle for solo drafting.

---

## 2. Threaded comments

### Strategic value

Felt advertises comments on every plan. This is the second leg of the
collaboration story. Once drawings exist, comments anchored to drawing
features are the natural complement to redlines: "marked this fence
line wrong — see the polygon I drew."

### Design

A comment thread is a new sub-entity attached by `parentRef` to one
of: map, data_layer, feature (id within a layer), or drawing feature
(id within a drawing set).

```ts
type CommentThread = {
  id: string;
  itemId: string;          // owning item (usually a map)
  parentRef: { kind: 'map' | 'layer' | 'feature' | 'drawing'; id: string };
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
};

type Comment = {
  id: string;
  threadId: string;
  authorId: string;
  body: string;            // markdown
  createdAt: string;
  editedAt?: string;
};
```

### Landing points

- New Prisma models `CommentThread` + `Comment` under
  `apps/portal-api/prisma/schema.prisma`.
- New `apps/portal-api/src/comments/` module: service + controller +
  guard (re-uses sharing model for read/write permissions).
- `apps/portal-web/src/app/items/[id]/tool/` — comments pane in the
  editor (Phase 1) and feature popovers (Phase 2).
- Notifications: backend hook on comment create, push to an existing
  notifications surface (we have nothing today; this is its own small
  unblock).

### Phases

- **Phase 1 — map-level comments.** Sidebar shows all comments on the
  map. No anchoring to features. Resolve / reopen. Markdown body.
- **Phase 2 — feature-anchored comments.** Click a feature in a layer
  or a drawing → comment thread pinned to that feature id. Threads
  render as small pins on the map at the feature centroid.
- **Phase 3 — @-mentions and notifications.** Mention an org member;
  they get an in-portal notification and an email.

### Dependencies

- Phase 1: independent.
- Phase 2: needs drawing primitive (#1) for drawing-feature anchoring;
  works on data_layer features independently.
- Phase 3: needs a notifications surface (could be a small in-portal
  bell first, email later).

### Effort

Small for Phase 1. Medium for Phase 2 (the rendering layer for pins
plus feature-id stability is the non-trivial part). Medium for Phase 3.

### Success criteria

- A viewer with comment permission can leave a comment and another
  viewer sees it on next load.
- A comment can be resolved; resolved comments hide by default but are
  retrievable.
- Phase 2: clicking a feature pin opens the thread; new comment writes
  back to the same thread.

### Open questions

- Email notifications path: do we want to send mail at all, or just
  in-portal notifications? Initial answer: in-portal first, email a
  later opt-in.
- Anonymous comments on public maps: same answer as drawings —
  rate-limited, optional captcha per item.

---

## 3. Live cursors / presence

### Strategic value

The third Figma-for-maps leg. HN commentary is skeptical of Felt's AI
features but consistently respects the multi-cursor experience. The
phase-1 lift (presence indicators only) is cheap and the marketing
read is high.

### Design

A presence layer over the map editor:

- **Phase 1 — presence + cursors.** Show "who's currently viewing this
  map" as avatar chips in the toolbar. Each viewer's cursor position
  on the canvas broadcasts over WebSocket and renders as a labeled
  cursor for other viewers. No state replication beyond cursor x/y +
  selected feature id.
- **Phase 2 — CRDT for drawings.** Drawings (which are append-only
  arrays of features per author) become Yjs documents. Two viewers can
  edit the same drawing set concurrently without lost updates.
- **Phase 3 — CRDT for everything else.** Layer reorder, style
  changes, viewport. Hardest because these are deep nested JSON.

### Landing points

- New `apps/portal-api/src/realtime/` module: Nest WebSocket gateway,
  one room per map id. Auth via existing JWT or share-link token.
- `apps/portal-web/src/components/map/presence-overlay.tsx` (new):
  renders other viewers' cursors and avatars over the map canvas.
- Phase 2: vendor `yjs` + `y-websocket` server adapter; new
  `apps/portal-api/src/realtime/yjs-bridge.service.ts`.

### Phases

- **Phase 1 — presence + cursors.** No state replication. Cheap.
- **Phase 2 — collab drawings via Yjs.** Builds on #1.
- **Phase 3 — collab map state.** Long tail.

### Dependencies

- Phase 1: independent.
- Phase 2: drawings (#1).
- Phase 3: significant rework of the map editor data flow; not in
  this quarter.

### Effort

Phase 1 is small. Phase 2 is medium and the lion's share of the value;
once it works, the collaboration story is fully comparable to Felt
for the drawings surface, which is the surface buyers actually care
about. Phase 3 is large and deferred.

### Success criteria

- Two browsers on the same map see each other's cursors moving in
  near-real-time (sub-200ms perceived).
- Disconnect-reconnect of one viewer cleans up the avatar chip and
  the cursor from other viewers' canvas.

### Open questions

- WebSocket transport: do we run a separate process or share the
  portal-api process? Initial answer: same Nest app, separate Gateway,
  same JWT auth. If load demands it, split later.

---

## 4. Workflows DAG (generalize the recipe runner)

### Strategic value

This is the CARTO Workflows analog. The single feature non-SQL CARTO
users praise unprompted. We have most of the engine: the recipe runner
already orchestrates `OsmRelationalQueryAction`, spatial-filter Tool
steps, and chained derived-layer pipelines. The gap is shape — it's
currently a linear list, not a directed graph — and node library
breadth.

### Design

Recipe shape change: from `actions: RecipeAction[]` to
`nodes: RecipeNode[]` + `edges: RecipeEdge[]`. A node has typed
input ports and typed output ports; edges connect them. Cycles
forbidden; topological order at execution time.

New node kinds (beyond what we already have):

- Geometry: `buffer`, `clip`, `dissolve`, `centroid`, `convex_hull`,
  `union`, `difference`, `simplify`.
- Aggregation: `h3_aggregate`, `quadkey_aggregate`, `grid_aggregate`.
- Attribute: `calculator` (column = expression), `rename`, `drop`,
  `filter` (already exists).
- Join: `spatial_join`, `attribute_join`.
- Source: `data_layer` (already exists), `osm_query` (already
  exists), `derived_layer`, `postgis_live` (#5).
- Sink: `materialize_to_data_layer`, `materialize_to_derived_layer`,
  `email_export`, `webhook_export`.

### Landing points

- `packages/shared-types/src/tool.ts` — schema bump from `actions[]`
  to `{nodes[], edges[]}`. Keep `actions[]` readable for backward
  compat with a one-time migration that wraps each legacy action in a
  single-node DAG.
- `apps/portal-api/src/tools/recipe-runner.service.ts` — topological
  sort, per-node execution, intermediate-result caching by node id.
- `apps/portal-web/src/app/items/[id]/tool/recipe-editor.tsx` —
  replace the linear list editor with a node-graph canvas. Vendor
  `reactflow` (already-evaluated graph library, MIT, no big deps).

### Phases

- **Phase 1 — DAG runtime.** Schema bump + runner upgrade. UI stays
  on linear list (presented as a degenerate DAG). All existing
  recipes keep working.
- **Phase 2 — node library expansion.** Ship the geometry + attribute
  + join nodes listed above.
- **Phase 3 — visual graph editor.** Replace recipe-editor with
  reactflow canvas; keep the linear view as an alternative for simple
  recipes.

### Dependencies

None. Independent track.

### Effort

Large. Easily a multi-week sprint. But the runner is the half that's
done; node library is mostly thin wrappers over PostGIS functions;
the graph UI is a known library.

### Success criteria

- A user can chain three nodes (read layer → buffer → spatial join)
  in the visual builder and run it.
- Existing single-action recipes (Select By Location, OSM tools) run
  unchanged through the new runner.
- A failed mid-DAG node surfaces the specific node + error rather
  than a generic recipe failure.

### Open questions

- Do we re-use the recipe item type or create a new `workflow` item
  type? Initial answer: re-use `tool` / recipe. The DAG is the
  evolution of the existing shape, not a sibling concept. Saves us a
  migration of all the existing tool items.

---

## 5. PostGIS live-read connector

### Strategic value

Felt and CARTO both gate live-warehouse connectors to Enterprise. We
ship to open-source self-hosters whose warehouse very often is
PostGIS already. Day-one live-read is a clean differentiator. We
already have an existing pattern in `arcgis_service` for an
externally-hosted source.

### Design

New item type? Or new variant of `data_layer`?

Before borrowing AGO's shape here, the question to ask is whether AGO
treats this as a feature service (data_layer-shaped) or as a workspace
connection (separate construct). AGO treats it as a registered store
plus a service. We can simplify: a new `data_layer` source kind,
`postgis_live`, that points at a connection + a schema-qualified
table name, and reads on every request rather than copying.

```ts
type PostgisLiveSource = {
  kind: 'postgis_live';
  connectionId: string;     // FK to a managed connection record
  schema: string;
  table: string;
  geometryColumn: string;   // default 'geom'
  idColumn?: string;        // default 'id' or table PK
  selectColumns?: string[]; // null = all
  whereClause?: string;     // safe-parsed; param-bound
};
```

A new `Connection` model holds credentials encrypted at rest
(reuse our existing `CREDENTIAL_ENCRYPTION_KEY` infrastructure), the
host + port + db + role, and a statement_timeout default.

Hard limits enforced server-side: row cap per request, statement
timeout, SQL identifier validation on schema/table/column inputs.
Already have the geometry validator and statement_timeout pattern
in place from the security review.

### Landing points

- New Prisma model `Connection`.
- `apps/portal-api/src/items/sources/postgis-live.service.ts` (new) —
  query builder using `pg` client with separate pool keyed by
  connection id.
- `apps/portal-api/src/items/items.service.ts` — when reading a
  `data_layer` whose source is `postgis_live`, dispatch to the live
  service instead of the v3 table read.
- `apps/portal-web/src/app/items/new/` — new "Connect to PostGIS"
  wizard with schema browser.

### Phases

- **Phase 1 — single-table live-read** with WHERE clause filter and
  bbox filter. Read-only.
- **Phase 2 — schema browser** in the UI: pick a connection, browse
  schemas + tables, preview, click to register as a data_layer.
- **Phase 3 — Snowflake / BigQuery** connectors using the same
  abstraction. Deliberately deferred until PostGIS pattern is proven.

### Dependencies

Reuses the existing `Connection`-style encryption pattern we set up
for `ago_oauth_connection`. No blockers.

### Effort

Medium. Most of the work is the connection-management UI and the
bbox-aware query building. The PostGIS query itself is one line.

### Success criteria

- A registered PostGIS table renders on a map without copying any
  rows into our portal database.
- Editing the WHERE clause server-side reflects on next map load.
- A statement_timeout enforcement kicks in for a deliberately bad
  query and returns a sane error to the UI.

### Open questions

- Do we ever want write-through to the live PostGIS table? Initial
  answer: no, not in v1. Read-only is the contract.

---

## 6. Print / PDF export — enhancements on top of print_template

### Strategic value

Both reference vendors punt on this. QGIS Print Layout is the bar.
Buyers ask for it on every call.

**Important correction:** the original roadmap entry treated this
as greenfield, but `print_template` is already a first-class item
type (shipped under #101). It carries:

- Paper sizes (Letter / Legal / Tabloid / A3 / A4) + orientation +
  margin.
- A free-positioned-element canvas: Text, Image, Map, Legend,
  Scalebar, North arrow, Line, Rectangle.
- Parameters surfaced as a runtime form, with chip-based
  token-segment bindings (no string-expression authoring required).
- Smart auto-binding for map-derived elements (the active map's id
  flows automatically into Map / Legend / Scalebar / North arrow).
- Runtime integration via the Print tool widget in Custom Web Apps.

So the work for #159 is **enhancement**, not replacement, and it
narrows substantially:

- A direct "Print this map" affordance on a map item that
  doesn't require building a Custom Web App first (today the
  designer is per-template; printing a map requires wrapping it
  in a Custom Web App with a Print widget). This is the
  smallest-team killer wedge.
- A higher-fidelity server-side render path (Puppeteer) that
  produces a proper vector PDF instead of leaning on the
  browser's `window.print()`. Closes the "the print preview
  came out wrong" failure mode.
- Per-map "default print template" pointer so a map can carry
  the print layout it expects to be printed with.

### Existing primitive (what already ships)

The `print_template` item type (#101) carries everything you'd
expect from a print designer:

- Paper sizes: Letter, Legal, Tabloid, A3, A4 + orientation +
  margin.
- Free-positioned-element canvas: Text, Image, Map, Legend,
  Scalebar, North arrow, Line, Rectangle.
- Author-declared parameters surfaced as a runtime form, with
  chip-based token-segment bindings (no string-expression
  authoring required).
- Smart auto-binding for map-derived elements: a print Map /
  Legend / Scalebar / North arrow auto-resolves to the active
  map widget at runtime.
- Runtime integration via the Print tool widget in Custom Web
  Apps, which today invokes `window.print()`.

So the engine is largely there. The gap is the UX bridge from a
plain map to the print designer, plus the higher-fidelity render
path.

### Landing points (enhancement on top of #101)

- `apps/portal-web/src/app/items/[id]/map/` — add a Print button
  on the map editor / viewer toolbar that opens a thin chooser:
  "use an existing print_template, or start a new one pre-bound
  to this map." Picks the template, opens
  `apps/portal-web/src/app/items/[id]/print-template/` already
  bound to the calling map.
- `apps/portal-api/src/print/` (new) — Puppeteer-driven render
  service. Headless browser, page-size set from the template's
  PrintPaperSpec, vector PDF output. Replaces `window.print()`
  on the render side.
- `packages/shared-types/src/print-template.ts` — optional
  `defaultMapId` on PrintTemplateData so a template that was
  authored against a specific map remembers it.

### Phases (revised)

- **Phase 1 — "Print this map" entry point.** A button on the
  map item that opens the existing print designer pre-bound to
  the calling map. Today an author must build a Custom Web App
  wrapper just to print a map; Phase 1 removes that step.
- **Phase 2 — server-side Puppeteer render path.** Replaces
  `window.print()` for vector-fidelity PDFs. Same template
  shape, same designer, just a better renderer.
- **Phase 3 — drawings included in print** (auto-respect
  visibility toggles). Depends on the drawings primitive.

### Dependencies

Drawings (#1) for Phase 3. Phases 1 and 2 are independent and
can interleave with other work.

### Effort

Smaller than originally scoped. Phase 1 is a single button +
chooser dialog + a thin server endpoint. Phase 2 is the
Puppeteer pipeline. Phase 3 is a per-print-job drawings query
that the existing renderer already knows how to overlay.

### Success criteria

- Phase 1: an author on any map can click "Print" and land in
  the print designer with the calling map already wired up.
- Phase 2: the exported PDF is vector for text and lines, raster
  only for basemap tiles.

### Open questions

- Vector tiles in PDF (so layers stay vector)? Initial answer:
  yes for layer geometry, no for basemap (basemap is rasterized
  to keep the PDF size bounded).

---

## 7. Smart upload (geocode + geomatch)

### Strategic value

Felt's "upload anything" pitch is half ingest support (which we
already have) and half post-upload smart detection (which we don't).
Closing the smart-detection gap removes the most common "but I need
to clean my data first" objection.

### Design

After a file uploads, the ingest service runs a profiling pass:

- Column type inference (already partly done).
- **Address detection:** heuristic match against a column pattern
  (street number + street name + city + state + zip). Surface a
  suggestion: "Looks like an address column. Geocode with Nominatim?"
- **Boundary-name detection:** match column values against vendored
  boundary lookups (US states, US counties, US ZCTAs, country ISO,
  country name). Surface a suggestion: "Looks like US state names.
  Geomatch to state polygons?"
- **Coordinate-pair detection:** look for paired latitude / longitude
  columns even if poorly named ("LAT" / "LONG" / "x" / "y").

If the user accepts the suggestion, the ingest does the resolution
and writes a geometry column.

### Landing points

- `apps/portal-api/src/ingest/ingest.service.ts` — add a
  `profileColumns()` step before commit.
- Vendor boundary sets to a new `apps/portal-api/content/boundaries/`
  tree: US-state-2025.geojson, US-county-2025.geojson,
  US-zcta-2024.geojson (smallest one we can ship), countries.geojson.
- Nominatim is already optionally on; if absent, geocoding suggestion
  is suppressed.
- `apps/portal-web/src/app/items/new/ingest-suggestions.tsx` — the
  post-upload "smart suggestions" screen.

### Phases

- **Phase 1 — coordinate-pair detection.** Easy and unblocks the
  silent failure mode where users upload a CSV and get no map.
- **Phase 2 — geomatch (boundary lookups).** Vendor the boundary sets,
  ship the lookup, surface the suggestion.
- **Phase 3 — geocode (Nominatim).** Already infrastructure-ready;
  just need the suggestion + execution path.

### Dependencies

None.

### Effort

Small-to-medium per phase. Most of the cost is data sourcing for the
vendored boundary sets and getting the licensing right (Census TIGER
for US, public domain; Natural Earth for countries, public domain).

### Success criteria

- Uploading a CSV with "lat" + "lng" columns produces a mapped
  data_layer with no manual schema editing.
- Uploading a CSV with a "State" column and "Population" column
  produces a state-polygon data_layer joined to the population.

### Open questions

- Where do vendored boundary sets live? Initial answer: in the
  portal-api image at build time. Adds ~30-50 MB. Acceptable.

---

## 8. MCP server

### Strategic value

Felt's MCP is Enterprise-only. CARTO's MCP is Enterprise-only.
Shipping one in the open positions us cleanly. Implementation cost
is small because the engine is the existing tool / recipe runner.

### Design

A small MCP server (Node) that:

- Authenticates via API key (existing API-key infrastructure).
- Exposes the following tools on connect:
  - `list_items` (scoped to API-key permissions).
  - `read_layer_features` (with bbox + WHERE clause filter; reuses
    public/features controller).
  - `run_tool` (executes a recipe; reuses the tool-run path).
  - `query_osm` (executes a relational OSM query; reuses the OSM
    relational engine).
  - `create_data_layer_from_geojson` (idempotent on item id).

### Landing points

- New `apps/portal-mcp/` workspace OR a `apps/portal-api/src/mcp/`
  module exposing on a separate port. Initial answer: separate Node
  workspace to keep MCP transport concerns out of Nest.
- Reuses existing services from portal-api over internal HTTP / a
  shared library. No new business logic; this is glue.

### Phases

- **Phase 1 — read-only tools** (`list_items`, `read_layer_features`,
  `query_osm`).
- **Phase 2 — write tools** (`run_tool`, `create_data_layer_from_geojson`).

### Dependencies

None.

### Effort

Small.

### Success criteria

- A Claude / Cursor session configured with a GratisGIS API key can
  list items and read layer features.

### Open questions

- Do we publish a separate npm package for the MCP server, or only
  ship as a Docker image? Initial answer: Docker image first, npm
  package later if there's demand for self-installation.

---

---

## 9. Multi-language / i18n — cross-cutting

### Strategic value

Demo-portal sign-ins from the EU and South America have made it
visible that the English-only UI is a real adoption blocker for the
exact audience GratisGIS is trying to serve (small teams in places
where commercial GIS pricing is even harder to justify than in the
US). Felt and
CARTO are both English-first today; Felt's docs are English-only,
CARTO's docs offer a smattering of Spanish marketing pages but the
product UI is English. Shipping a real localized product is a
differentiator on its own.

This is the right kind of work to farm out to the community.
Translations are the canonical open-source contribution surface:
high-impact, low-context, parallelizable, no commit access to
sensitive code paths required. The constraint is that the codebase
has to be i18n-ready first — community contributors translate
key-value catalogs, not search-and-replace a React tree.

### Design

Three layers of localization, each with its own toolchain:

**1. Portal-web UI strings.** App Router-friendly stack is
`next-intl`. Every visible string moves out of JSX into namespaced
translation JSON files keyed by locale (`en.json`, `es.json`,
`pt-BR.json`, `fr.json`, `de.json`, ...). ICU MessageFormat for
plural / select / number / date interpolations.

**2. Portal-api error messages and email templates.** Smaller surface
but every API error message that ever reaches a user needs the same
treatment. NestJS i18n module (`nestjs-i18n`) handles the same
JSON-catalog model server-side; the locale comes from the
`Accept-Language` header or an explicit `?lang=` query.

**3. Locale-aware formatting** for everything users see:
- Numbers (thousands separator, decimal mark) via `Intl.NumberFormat`.
- Dates / times via `Intl.DateTimeFormat`.
- Coordinates: degrees-minutes-seconds vs decimal degrees, locale-
  selectable.
- Units: already locale-selectable via the existing unit picker per
  the project's plain-language convention; default-by-locale wiring
  is the additional step (imperial default for US English, metric
  for everywhere else).

### Landing points in code

- `apps/portal-web/src/i18n/` (new): catalogs, `next-intl` config,
  middleware for locale routing.
- `apps/portal-web/next.config.mjs`: add the i18n locale list.
- `apps/portal-web/src/middleware.ts`: locale detection from
  `Accept-Language` + cookie persistence of user's choice.
- Every `apps/portal-web/src/app/**/*.tsx` and
  `apps/portal-web/src/components/**/*.tsx` file: replace hard-coded
  strings with `t('namespace.key')` calls. This is the bulk of the
  mechanical work.
- `apps/portal-api/src/i18n/` (new): `nestjs-i18n` setup, catalogs,
  middleware.
- `apps/portal-api/src/items/items.service.ts` and every other
  service that throws user-facing errors: replace hard-coded English
  with i18n keys.
- `packages/shared-types/src/locales.ts` (new): the canonical locale
  list (BCP-47 codes) shared between web and api so the catalogs stay
  in sync.

### Phases

- **Phase 1 — i18n-readiness pass.** Wire `next-intl` + `nestjs-i18n`,
  build a string-extraction script, replace every hard-coded English
  string with a key, ship English as the reference catalog. No
  visible UX change. This is the part that has to land before the
  community can usefully contribute.
- **Phase 2 — Hosting + community workflow.** Stand up a Weblate
  instance (open-source self-hosted, AGPL-licensed) OR use Crowdin's
  free-for-open-source program. CI integration: a PR from the
  translation platform → reviewer pass → merge. Add a `CONTRIBUTING-
  TRANSLATIONS.md` and a per-locale completeness badge on the README.
- **Phase 3 — Bootstrap priority locales.** Seed Spanish (es-ES,
  es-419 for Latin America), Portuguese (pt-BR), French (fr-FR),
  German (de-DE) using machine translation as a starting point, then
  flag for community review. The demo telemetry should drive the
  priority order rather than guessing.
- **Phase 4 — Locale switcher in the portal UI.** Top-right menu
  drop-down, persists choice in user prefs (signed-in) or cookie
  (anon).
- **Phase 5 — Locale-aware defaults.** Default unit system, date
  format, number format, coordinate format derived from the user's
  locale unless explicitly overridden.

### Dependencies

None blocking. Should run as its own stream in parallel with the
collaboration and analytics streams. Phase 1 is a one-time effort;
Phases 2-5 sequence.

### Effort

- Phase 1 is the biggest single chunk by far. Realistically a multi-
  week pass for a single developer because every component needs
  touching. A string-extraction codemod (`react-intl-cli`-style)
  cuts the manual work significantly.
- Phases 2-5 are each small. The leverage from Phase 1 is enormous;
  every subsequent language is mostly community time.

### Success criteria

- Phase 1: `pnpm extract-i18n` produces a complete `en.json` catalog
  covering every visible string. No hard-coded English remains in
  any `.tsx` or in any user-facing API error.
- Phase 2: a community contributor with no portal-api access can
  submit a Spanish translation that goes through review and ships in
  the next release.
- Phase 3: Spanish + Portuguese + French + German UI runs end-to-end
  through the demo portal, including all error paths.
- Phase 4: signed-in user's locale preference persists across
  sessions.
- Phase 5: a new user in São Paulo sees pt-BR by default, metric
  units, dd/mm/yyyy dates, comma decimal mark — without changing a
  single setting.

### Open questions

- **Weblate vs Crowdin vs Tolgee.** Weblate is the strongest open-
  source fit (AGPL, self-host) but adds infra to maintain. Crowdin
  is free for OSS but is hosted SaaS and creates a soft dependency
  on a US company. Tolgee is a newer hybrid — open core + paid hosted.
  Recommend Weblate self-hosted to keep the OSS-stack-purity story
  intact, but call this out as a deliberate choice.
- **OSM preset translations** are a separate vendoring problem —
  the iD-presets catalog ships its own translation files we should
  consume rather than re-translate. Currently our OSM toolset uses
  English preset labels.
- **RTL languages** (Arabic, Hebrew, Persian) are a deeper UI lift
  than just translation — every flex direction in the design system
  needs auditing. Mark as a Phase 6 explicit non-goal for now;
  ship LTR languages first and revisit RTL once Phase 4 lands.
- **Domain-specific vocabulary** — "data layer," "map," "feature,"
  "form submission collection" — these have established translations
  in the GIS community in some languages but not others. Glossary +
  context comments on each translation key are essential or
  community translations diverge into incompatible vocabularies.

### Community farming strategy

The work that genuinely benefits from being community-farmed:

- All translation content (every locale beyond English).
- Domain glossaries per locale.
- Locale-specific QA (does the German UI handle compound words
  cleanly, do the Spanish strings overflow buttons, etc.).
- Documentation translation (`docs/` and the public marketing site).

The work that should stay in-house:

- Phase 1 i18n-readiness pass (touches every component, needs
  judgment on key naming and namespace structure).
- The translation platform infrastructure choice and operation.
- Anything that requires reading or modifying business logic.

Suggested first community ask, after Phase 1 lands: a single bilingual
contributor per locale to seed each priority language, then open the
catalog to anyone via Weblate.

---

## Deliberately deferred

- **Routing (#154).** Still excluded per prior directive. Revisit when
  OpenRouteService self-host footprint is re-evaluated.
- **AI agents that generate dashboards / workflows from a prompt.**
  Felt and CARTO both lean on this; the HN crowd consistently calls
  the results bolted-on. Don't ship until the no-code DAG (#4) is
  solid. AI on a weak primitive doesn't read as compelling.
- **Snowflake / BigQuery / Databricks connectors.** Same shape as
  PostGIS live-read, deferred until PostGIS pattern is proven.
- **Phase 3 of live cursors (collaborative edits on map state beyond
  drawings).** Diminishing returns vs. Phase 2.
- **Mobile / field app feature parity with Felt.** We already ship a
  field PWA; bringing it to Felt-equivalence is a separate roadmap.

## Risks and unknowns

- **CRDT operational complexity.** Yjs is well-trodden but adds a
  WebSocket session model we don't have today. The graceful-failure
  story (what happens when a viewer's connection drops mid-edit) is
  the hard part, not the happy path.
- **PDF render fidelity.** Vector-text-with-raster-basemap is the
  industry compromise, but every customer eventually asks for
  fully-vector output. Set expectations early.
- **MCP tool authorization model.** API keys scope what an MCP client
  can do; getting the scoping granular enough that an MCP key can be
  "read-only on this folder" is its own design problem. Probably
  needs a v2 API key model.
- **Drawing-set sharing semantics in the public-anonymous case.** The
  "anyone can redline a public map" pitch is the killer for the
  manager-redline use case, but it also opens an abuse surface.
  Captcha + rate-limit + opt-in per map is the design lever; the
  default should err on the side of "comments-and-drawings off by
  default for public maps; admin opts in."

## Suggested sequencing for the next quarter

Roughly six-week phases, three streams in parallel:

**Stream A (collaboration):**
1. Drawings primitive Phase 1 (2 weeks)
2. Comments Phase 1 (1 week)
3. Live cursors Phase 1 (1 week)
4. Drawings Phase 2 + Comments Phase 2 + Live cursors Phase 2 (2 weeks)

**Stream B (analytics + ingest + export):**
1. Workflows DAG runtime + node library Phase 1 (3 weeks)
2. PostGIS live-read Phase 1 (1 week)
3. Print/PDF Phase 1 (2 weeks)
4. Smart upload Phase 1 (slot in across)
5. MCP server Phase 1 (slot in across)

**Stream C (i18n):**
1. i18n-readiness pass — wire `next-intl` + `nestjs-i18n`,
   string-extraction codemod, English-as-reference catalog
   (multi-week mechanical sweep, can interleave with Streams A/B)
2. Translation platform setup (Weblate) + `CONTRIBUTING-TRANSLATIONS.md`
3. Locale switcher + locale-aware default formatting
4. Seed Spanish + Portuguese + French + German via machine + community
   review (kicked off after Stream C Phase 2 lands)

End-of-quarter state if all three streams land:

- "Figma-for-maps" feature parity with Felt on the collaboration
  surface that actually drives buying decisions.
- A CARTO Workflows-equivalent visual DAG with the most-asked-for
  spatial primitives.
- Day-one live PostGIS read where Felt and CARTO both gate it to
  Enterprise.
- Print/PDF that's better than either vendor ships.
- An open MCP where both vendors gate theirs to Enterprise plans.
- A localized portal serving the EU + LATAM audience that's been
  hitting the demo in English-only mode, with a community-translation
  workflow that scales beyond what the maintainer can do alone.

That is a defensible quarter's roadmap on its own merits.
