# Analyze workflow UX: curated tools, deep links, quick actions (2026-10-30)

Discussion note from peer-product IA review. Steal information
architecture, keep GratisGIS execution on PostGIS / derived layers.
No external product names in follow-on commits.

Companion to
[spatial-analysis-workbench-2026-07-19.md](./spatial-analysis-workbench-2026-07-19.md)
(primitives + recipes). This note is about the *surface*: how people
find, share, and re-run the guided Analyze shortcuts we already ship.

## Thesis

The Analyze tab already has a curated chip row of everyday PostGIS
shortcuts (Buffer, Clip, Erase, Centroid, Hull, …) plus the
DuckDB-WASM SQL builder. The gap is not more tools — it is
addressability and reach:

1. A shareable tool id for help, demos, MCP, and docs.
2. One-click analysis from the map layer row (the place people are
   looking when they think "buffer this").
3. Later: run history, one dialog shell from parameter manifests,
   and a real recipe DAG — without pretending we are a 1,000-tool
   client WASM toolbox.

## Steal (patterns)

### Curated everyday vs deep catalog

Keep the Analyze chip row sharp. Heavy terrain / hydro / LiDAR stay
on honest server-tier or separate item paths, not a fake mega-menu.
The workbench research already says primitives + starter recipes;
this note reinforces the front door: few named shortcuts, deep
catalog via derived-layer pipeline and SQL.

### Category browse + search + tool deep links

`?tool=<id>` (plus `#data` and optional `&layer=<sublayerId>`) opens
the Data tab's Analyze surface with that guide expanded. Same id in
help URLs and future MCP hints. Cheap win; no new backend.

### Layer context → quick analysis

Map layer kebab (and later the data-layer row) offers Buffer /
Centroid / Convex hull for `data-layer` sources. Action navigates to
the source item's Analyze deep link so the existing guided form runs
— no second Buffer implementation.

### Run history (later)

Surface derived-layer / recipe job history with Re-run and Edit &
re-run. We already create derived layers; history is the missing
shelf, not a new engine.

### Parameter manifests → one dialog shell (later)

One form renderer driven by tool metadata instead of a bespoke panel
per guide. Guides today are honest and small; unify when the chip
count or history editor needs it.

### Model builder as next recipe phase (later)

Real PostGIS-backed DAG when graphs ship. Help already admits
recipes are linear. Do not cosplay client-side model builders.

### Catalog naming discipline

If a client DuckDB path and a server PostGIS path ever share a
label, place and name them so "Buffer" is not ambiguous. Today the
guided Buffer is server-only by design; keep that honesty.

## Do not chase

- A 1,000-tool WASM geoprocessing suite.
- Planetary basemap / multi-engine switching as a headline.
- AI model-builder marketing before linear recipes + history are
  solid.
- Duplicating Analyze forms inside the map editor.

## Ship order (autonomy)

| Priority | Slice | Queue id | Notes |
| --- | --- | --- | --- |
| 1 | Research + queue refill | Q-analyze-workflow-ux | This doc |
| 2 | Analyze `?tool=` deep link | analyze-tool-deeplink | Open `#data` + Analyze + matching guide |
| 3 | Map layer quick analysis | analyze-layer-quick-actions | Buffer / Centroid / Hull → deep link |
| 4 | Run history shelf | analyze-run-history | needs design pass; likely ship-without-input once scoped |
| 5 | Manifest-driven dialog shell | analyze-param-manifests | after 2–3 guides grow stale |
| 6 | Recipe DAG | recipe-dag | needs-maintainer if product scope expands |

Items 2–3 are `ship-without-input`. Items 4–5 start as
`ship-without-input` once a thin vertical slice is obvious. Item 6
stays `needs-maintainer` until linear recipes + history land.

## Deep-link contract (item 2)

On a `data_layer` item page:

- `#data` — existing ItemTabs hash; selects the Data tab.
- `?tool=<id>` — Analyze guide id (see registry below).
- `?layer=<sublayerId>` — which v3 sublayer row opens Analyze.
  Optional when the item has exactly one downloadable sublayer.

Unknown `tool` values are ignored. Opening the link expands the
matching guide form; it does not auto-submit.

### Tool ids (stable)

`buffer`, `clip`, `erase`, `centroid`, `convex-hull`, `bbox`,
`dissolve`, `simplify`, `densify`, `vertices`, `calculate-geometry`,
`nearest-neighbor`, `fishnet`, `contour`, `group-by`, `top-n`,
`random-sample`.

Example: `/items/<id>?tool=buffer&layer=<layerKey>#data`

## Related code

- `apps/portal-web/src/app/items/[id]/data-layer/layer-analyze-panel.tsx`
- `apps/portal-web/src/app/items/[id]/data-layer/v3-layer-data-panel.tsx`
- `apps/portal-web/src/app/items/[id]/map/layer-panel.tsx`
- `apps/portal-web/src/app/items/[id]/item-tabs.tsx` (`#data`)
