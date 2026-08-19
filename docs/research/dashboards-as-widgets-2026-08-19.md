# Dashboards as widgets, not as an app

Direction set by Matt, 2026-08-19: dashboards are not their own
implementation. They are widgets available to every web app, plus
starter templates, and the result of starting from a template is an
ordinary web app the owner can modify however they like. This document
checks that direction against what exists in the code today, specs the
missing pieces, and names the decisions still open.

## The failure mode this avoids

The reference platform splits app-building across products (Dashboards,
Experience Builder, the older builders), each with its own widget set,
config model, and gaps. The recurring cost is building in one and then
discovering the one capability you need lives in the other, with no
migration path. The root cause is not bad widget design; it is that
each product owns a private runtime, so capabilities cannot travel.

The direction here inverts that: one runtime (the custom web app), one
widget registry, and "dashboard" as a starting configuration rather
than a product boundary. A dashboard that grows a map viewer, an edit
tool, or a survey panel never hits a wall, because those widgets were
always available in the same palette.

This also matches standing doctrine: `docs/item-type-guidance.md`
already says dashboards land as a web_app template, not their own
type, and the `editor` consolidation (#258) is the precedent for what
it costs to get this wrong (a data migration to fold a type back in).

## Ground truth: most of this exists (verified 2026-08-19)

The custom web app is much further along than the older docs admit
(`docs/app-builder.md` still says "Not implemented"; it describes a
proposal from before the build and should be rewritten to match
reality when phase 1 below lands).

What ships today:

- **A widget registry with 28 kinds** in
  `packages/shared-types/src/custom-app.ts`, rendered by
  `items/[id]/custom/runtime-client.tsx` and arranged by the designer
  in `items/[id]/custom/detail.tsx` on a 192-column CSS grid with
  multi-page support, nested containers, and tabs.
- **A chart widget already exists** (`ChartWidgetConfig`: bar, line,
  pie, groupBy, count/sum/avg/min/max over a target layer). It is the
  seed of the dashboard story, with one load-bearing flaw covered
  below.
- **Widgets already dock, float, or collapse to toolbar buttons**
  (`displayMode` + `panelArrangement`), so "dashboard tile" and "map
  tool" are the same component in different arrangements.
- **Starter templates already work the way the direction asks.**
  `APP_TEMPLATES` / `STARTERS` in
  `packages/shared-types/src/app-templates.ts` are seeded per org as
  `app_template` items; the wizard clones one into a fresh, fully
  editable web_app. A dashboard template is one more entry, not a new
  mechanism.
- **Tools prove the "capability as widget" pattern.** A tool item
  embeds in any custom app (`kind: 'tool'`), reads host state
  (selection, extent, layers) through a parameter binding vocabulary
  (`hardcoded | runtime-host | runtime-draw | runtime-selection |
  runtime-pick | runtime-input`), and writes results back. Dashboard
  widgets should reuse this binding vocabulary rather than invent one.
- **The `dashboard` item type is a placeholder only**: no route, no
  runtime, hidden from the wizard (the legacy item form still offers
  it by accident), renders ComingSoon. Nothing to migrate.

## The three real gaps

**1. No server-side aggregation.** The chart widget fetches the whole
layer as GeoJSON and aggregates in browser JS. Fine for a hundred
features; wrong for the 24k-feature parcels layer, and unusable as the
basis for a KPI row that refreshes every minute. DuckDB-WASM (#175)
exists but is quarantined to the data_layer Analyze tab, works off the
GeoParquet export, and that export is gated by canDownload, which a
dashboard viewer may not hold.

**2. No refresh primitive.** Every timer in the runtime is job-status
polling or animation. Dashboards are the first surface where "the
number on screen goes stale" is a defect.

**3. Missing dashboard-grade widgets.** There is no indicator (single
number), no way to format or threshold one, and no
selector/filter widget that scopes its siblings.

## Spec

### Phase 1: the aggregate read path, indicator, refresh, template

**`GET /items/:id/layers/:layerId/aggregate`** on portal-api, next to
the existing feature read endpoints, engine-backed:

- Parameters: `groupBy` (0 to N property keys, N small), `aggs`
  (`count | sum:field | avg:field | min:field | max:field`), optional
  `bbox`, optional `where` reusing the features-search predicate
  vocabulary if cheap, otherwise deferred to phase 2 with the filter
  widget.
- Implementation reuses the group-by SQL generator that already exists
  in `derived-layers/tools/aggregate.ts`, pointed at the observation
  engine's latest-per-entity collapse. The collapse-then-filter order
  from the ghost-features fix applies to aggregates exactly as it does
  to reads: aggregating pre-collapse resurrects deleted features in
  the counts.
- **Authorization is the whole point of doing this server-side.** The
  endpoint applies `canRead`, the share geo limit, and
  `effectiveRowScope`, same as the five existing v3 read paths; an
  aggregate is a read and leaks exactly as much as a read. A dashboard
  shared to a row-scoped viewer must show that viewer's counts, not
  the org's. This is why client-side aggregation over a full export
  can never be the primary path.
- **Anonymous public dashboards need the pair**: a `@Public()` mirror
  and a BFF anonymous-rewrite allowlist row in
  `apps/portal-web/src/app/api/portal/[...path]/route.ts`. Four
  incidents in that file's comments say this is the step that gets
  missed.
- Response caps: group count capped (say 1000 groups) with a
  `truncated` flag, so a groupBy on a near-unique key degrades loudly,
  not by melting a replica.

**Indicator widget** (`kind: 'indicator'`): one aggregate value, big.
Config: target, agg, optional filter (phase 2), number format
(decimals, thousands, unit prefix/suffix), optional reference value
(fixed number or second aggregate) with above/below threshold colors
from the theme's semantic tokens. Renders in any app; a map app
gaining one KPI tile is the direction working as intended.

**Chart widget rewired** to the aggregate endpoint, keeping the
current whole-layer client path only as a fallback for targets below a
small feature count where a second request is sillier than the
download. The config shape does not change; existing apps get the fix
for free.

**Refresh primitive**: `refreshSeconds?` on the app (default off) and
per-widget override, floor of 15 seconds, timers pause when
`document.visibilityState` is hidden, jittered so a wall of dashboards
does not synchronize. Applies to indicator, chart, attribute-table,
and map feature sources. This is the first deliberate polling loop in
a runtime; keep it in one shared hook so the next widget inherits the
visibility and jitter behavior instead of reinventing it.

**Dashboard starter template(s)**: one or two `APP_TEMPLATES` entries
(e.g. `kpi-overview`: indicator row, chart pair, map with layer list;
`ops-board`: indicator column, table, map). The wizard's Apps group
gets a "Dashboard" tile that clones the starter, exactly like the
other starters. The user-facing word "Dashboard" survives; the
implementation is a regular custom web app from the first second.

**Retire the placeholder type** per the migration pattern in
item-type-guidance: remove `dashboard` from the legacy item form's
dropdown now, keep the enum value deprecated for existing rows (the
demo has none; self-hosters might), and route any existing dashboard
item's detail page to a one-time "convert to web app" affordance
instead of ComingSoon. Drop the enum value in a later release.

### Phase 2: filters and cross-widget scope

A `filter` widget (category selector, numeric range, date range)
that publishes a predicate into a per-page filter context; indicator,
chart, table, and map target sources subscribe. This is the piece
that makes a dashboard feel like a dashboard, and it is also the
piece most likely to be over-built: scope it to attribute predicates
on shared targets, reusing the features-search predicate vocabulary,
and let map extent participate as an optional "filter by current
view" toggle on subscribing widgets. No global cross-filter graph
editor; subscription is per-widget, visible in the inspector.

Also phase 2: a `list` widget (top-N rows by a field, linkable to
feature popups) and threshold bands on charts.

### Explicitly not in scope

- A separate dashboard runtime, builder, or item type.
- Streaming/websocket data; polling at tens of seconds is the honest
  ceiling of the substrate today.
- A DuckDB-WASM dependency in the runtime. It stays the power tool on
  the Analyze tab; dashboards ride the authorized server path.
- Gauges and sparkline microcharts; revisit after phase 2 ships and
  real dashboards exist to justify them.

## Decisions (Matt, 2026-08-19)

1. **Aggregate endpoint vocabulary**: groupBy + the five aggs + bbox
   only for phase 1. The `where` predicate lands with the phase 2
   filter widget that needs it.
2. **Display label**: a cosmetic `data.custom.blueprint` marker, read
   only by `getItemDisplayLabel` / icon narrowing (the same mechanism
   that shows "Editor" and "Viewer" today), so an app started from a
   dashboard template lists as "Dashboard". Capability is unaffected;
   the marker never gates behavior anywhere.
3. **Refresh default**: dashboard starters ship with refresh on at
   60s, visibility-paused; owners can turn it off per app.

## Sizing

Phase 1 is roughly: aggregate endpoint + clips + mirrors + specs (1-2
days), indicator widget + chart rewire + refresh hook (1-2 days),
starter template + wizard tile + placeholder retirement (about a
day). Phase 2 filter context is its own 2-3 day slice once phase 1
has soaked on the demo.
