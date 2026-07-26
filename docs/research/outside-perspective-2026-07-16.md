# Outside perspective: where GratisGIS goes next (2026-07-16)

A strategic deep-dive: what are we missing, is the UI professional
enough, are we wrong to skip 3D and advanced spatial analysis, and
where can GratisGIS differentiate rather than chase feature parity.
Based on a full UI audit of portal-web (202 tsx files), web research
current to July 2026 (Esri UC 2026 week), and the state of the repo
at commit 3454280.

## The framing question first

Competing with the incumbent cloud GIS platforms can mean two
different roadmaps. One is parity-chasing: match Scene Viewer, match
Map Viewer analysis, match Experience Builder, feature for feature.
The other is asymmetric: focus on what a metered, per-user revenue
model makes hard for any vendor to offer. The research is unambiguous
that the second is the winning frame, because AGO's weaknesses are
not engineering weaknesses. Esri shipped plenty in 2025-2026
(Gaussian splat layers with analysis tools, Google Photorealistic 3D
Tiles basemaps, AI assistants going GA, Parquet feature layers in
beta, MCP support for Location Services). The most common user
complaints about AGO center on the metering: feature storage at
roughly 200x the credit cost of file storage, analysis tools that
burn unpredictable credits, GeoAnalytics Server deprecated in favor
of a separately licensed Spark engine, concurrent use licenses
discontinued in Q2 2026, perpetual maintenance converted to
subscriptions. A credit-and-user-type revenue model leaves little
room to make any of that free at point of use.

So the thesis of this memo: wherever the established platforms meter
a capability, offer it free, instant, and open. A capability
delivered without a meter is a stronger differentiator than a novel
capability nobody else has.

## Part 1: The honest UI verdict

Short version: competent, unusually accessible, but not yet
professional-grade, and the gap is consistency rather than talent.
`docs/design-system.md` promises a Linear/Vercel-tier system; the
shipped code honors maybe 40% of it. A reviewer who reads the doc
and then clicks around will feel misled, which is worse than having
no doc.

The specific findings, ranked by impact on perceived professionalism:

1. Dark mode is built but dead. Full light and dark token pairs
   exist in `globals.css` (a `.dark` block), but nothing ever applies
   the class: zero `dark:` variants across 202 files, no theme
   toggle. Highest promise-to-effort ratio of anything on this list.
2. Dozens of independent modal implementations. 15 `*-dialog.tsx`
   files plus 38 more hand-rolling `fixed inset-0` backdrops. Radix
   is named in the design doc and imported nowhere. Focus trapping,
   escape handling, and scroll lock are reinvented or omitted per
   feature. One shared Dialog primitive fixes look and correctness
   in a single move.
3. No toast system at all. The doc mandates one; no library is
   installed; per-surface notification hacks instead.
4. Micro-text everywhere. `text-[11px]` appears 741 times and
   `text-[10px]` 352 times across 124 files, plus `text-[9px]` and
   `text-[8px]`. This is the single biggest "looks cramped and
   homemade" signal, and a readability liability. Needs a scale
   token and a codemod, with 12px as the floor.
5. Spinners where skeletons should be: 78 files use `animate-spin`,
   6 use skeleton patterns. The doc says the opposite.
6. Raw palette leakage: 678 occurrences of slate/amber/emerald/sky
   in 72 files instead of the semantic tokens. This is also the
   blocker for dark mode working once wired.
7. No brand. The logo is a stock lucide Compass next to "GratisGIS"
   in Inter. Geist Mono is specified in the config and never loaded.
   A real mark and loaded fonts are cheap first-impression wins.
8. Hand-rolled popover/menu keyboard behavior in 15 files.
9. No first-run experience. A new user in an empty org gets a gray
   dashed card. No sample data offer, no tour. This is exactly the
   30-minute-evaluation moment where AGO wins today, and it is
   already tracked as issue #147.
10. No visual regression gate (the doc claims Storybook/Chromatic;
    neither exists), so every fix above will re-drift without it.

Two things the audit found genuinely above average and worth
protecting: ARIA discipline (104 files, aria-live regions, reduced
motion respected globally) and deliberate responsive/mobile work
(safe-area insets, iOS zoom guard) well beyond the field PWA.

The verdict on "is it clean enough": the bones are professional
(the map editor's docked-pane BuilderShell skeleton is genuinely
good), the skin is inconsistent. A focused two-to-three week polish
pass on items 1 through 7 would move the gestalt from "capable
engineer's app" to "product." This is the cheapest credibility
available anywhere in this memo.

## Part 2: Are we missing the mark on 3D? Yes, and the timing is lucky

3D is AGO's most active front right now: Scene Viewer added Gaussian
splat layers with slice/line-of-sight/elevation-profile analysis,
volume measurement in the browser, and Google Photorealistic 3D
Tiles basemaps in the June 2026 release. A portal with no 3D answer
in 2027 will read as a 2D-only toy in evaluations.

The lucky part: the open standards for 3D just finished landing, so
there is no legacy to regret and a real first-mover window among
open portals. The stack is now settled and entirely self-hostable:

- Point clouds: COPC (cloud-optimized LAZ, single file, HTTP range
  requests, no server engine). PDAL/untwine produce it; MapLibre
  plugins and deck.gl render it. This is the cheapest 3D win: an
  upload pipeline plus static MinIO serving.
- 3D Tiles 1.1 is the settled interchange standard; even Esri now
  consumes it. deck.gl's Tile3DLayer renders 3D Tiles and Esri I3S
  as a MapLibre overlay, which means GratisGIS gets 3D rendering
  without abandoning its MapLibre substrate.
- Buildings from PostGIS: pg2b3dm (active, v2.27 March 2026) turns
  3D geometries straight into 3D Tiles. We are already PostGIS
  native; this is close to free.
- Terrain: quantized mesh or Terrain-RGB from an uploaded DEM;
  MapLibre handles Terrain-RGB today and it packs into PMTiles,
  which the portal already serves.
- Gaussian splats: the KHR_gaussian_splatting glTF extensions hit
  ratification around Q2 2026 with SPZ compression, and Cesium
  shipped splats-as-3D-Tiles with LOD in April 2026. Drone shops
  (a natural GratisGIS constituency) are about to produce these in
  volume, and the open pipelines (OpenSplat, nerfstudio) exist.

Recommended shape, deliberately NOT Scene-Viewer-shaped: no separate
"Scenes" item type or 3D viewer app. 3D layers are just layers: a
`point_cloud` (COPC), `tileset_3d` (3D Tiles), and `terrain` source
kind on the existing map item, rendered through a deck.gl overlay
the map canvas mounts when any 3D layer is present, with a pitch
toggle. AGO ships Map Viewer and Scene Viewer as separate apps. One
map that goes 3D when the data does is the better design and a
visible differentiator.

Phasing: (a) COPC upload + streaming + render, roughly the effort of
the PMTiles pipeline that already exists; (b) 3D Tiles item kind +
deck.gl Tile3DLayer + terrain; (c) pg2b3dm extrusion service for
building footprints with height attributes; (d) splat ingestion.
Phases a and b alone would put GratisGIS ahead of every open-source
portal and remove the "no 3D" objection.

## Part 3: Advanced analysis, free at point of use

This is the sharpest available contrast with metered platforms.
AGO's browser analysis is a fixed, credit-metered tool list; heavy
work needs Pro, Notebooks (more credits), or a separately licensed
Spark engine.

The 2026 open stack makes "every analysis free and instant" real:

- DuckDB's spatial extension became a built-in GEOMETRY type in 1.5
  (May 2026) and runs in the browser via DuckDB-WASM. Production
  apps already query Overture GeoParquet directly in-browser.
  Shipping an Analysis surface where any layer can be filtered,
  joined, buffered, and aggregated with spatial SQL executing on
  the client costs the server nothing and the user nothing. A
  credit-metered platform could not match this without giving up
  that revenue.
- GeoParquet is now a native Parquet/Iceberg type (Feb 2026) and
  even AGO added read-only Parquet layers in beta. GeoParquet
  import/export is table stakes for 2026 credibility and is also
  the interchange that feeds DuckDB-WASM, the future agent, and
  bulk export (#356 bundle export).
- The recipe/DAG runner that already shipped (#157) is the missing
  orchestration half: recipes become the server-side fallback for
  jobs too big for the browser, and every new analysis node enriches
  tools, derived layers, and the runtime panel simultaneously.
- PostGIS 3.6 (SFCGAL 2: 3D buffers, straight skeletons, coverage
  cleaning) is already under us; the gap is user-facing surface,
  not engine capability.
- Rasters are the genuinely missing modality: no COG story, no
  imagery, no STAC. COG plus a titiler-style dynamic tiler is the
  standard open answer and pairs naturally with the 3D work (DEMs
  serve terrain AND analysis). AGO meters hosted imagery heavily,
  so this is another free-vs-credits contrast.

## Part 4: The agent-native portal

Esri's UC 2026 was wall-to-wall agentic AI, but look at the shape:
per-app assistants (Arcade writing, form building, translation),
cloud LLMs only, nothing that runs real spatial analysis end to end,
and MCP only for Location Services. Felt's AI (natural language to
SQL over customer warehouses) is Enterprise-gated. CARTO's agents
are warehouse-native and aimed at data teams. Mundi.ai proves an
open AGPL "AI-native GIS" has demand, though it is a focused app
rather than a full portal.

GratisGIS already shipped an MCP server Phase 1 (#161, read-only
tools). The differentiating move is a permission-inheriting agent
that lives in the portal: it writes real SQL against the org's own PostGIS with
the caller's own share-scoped permissions, invokes recipes/tools as
its function library, styles layers, and works with local or
self-hosted LLMs. Open source, local model support, and full data
access is a combination none of the commercial platforms offer
today. The MCP Phase 2 write tools plus the recipe runner are most
of the plumbing.

## Part 5: The differentiator already in the codebase that nobody sees

The observation-log substrate is a genuine architectural advantage
that currently has no user-facing expression. Every edit is an
append-only observation; nothing is ever overwritten. AGO's mutable
feature model fundamentally cannot offer "show me this layer as of
last March" or "replay this dataset's history" without expensive
archive-enabled Enterprise geodatabases. GratisGIS could ship a
time-travel slider on any data layer, per-feature edit history with
who/when/what diffs, and one-click restore of any feature to any
prior state, essentially by writing UI over data that already
exists. This is the clearest case of a capability that falls out
of a better substrate, and it doubles
as an editing-safety story (nothing a field crew does is ever
unrecoverable) that municipal buyers will care about.

## Part 6: Unglamorous gaps that decide evaluations

- Install and first-run (#147): still the one greenfield ticket, and
  the top-of-funnel bottleneck. Single-command install, seeded
  sample data, guided first map. The 2026 Esri licensing changes are
  actively pushing orgs into evaluations; they have to be able to
  stand the thing up in an afternoon.
- Zero frontend tests (plan already exists: Playwright E2E first).
  The pace of UI change without a net will eventually bite a
  release.
- Observability (next-workstreams item 5): /metrics, readiness
  probe, admin performance page. Self-hosted operators need this to
  trust the thing.
- Tile cache (next-workstreams item 1, phases 1-3): still load
  bearing for everything above; the pool-storm class of incident
  remains open.
- Trust surface: a docs site, a security page (the audit work is
  done, publish it), WCAG statement, and the AGO importer framed as
  a first-class migration story on the landing page.

## The recommended sequence

1. Now, cheap, compounding: UI polish pass (dark mode, dialog/toast
   primitives, type scale, skeletons, brand mark) plus #147
   install/onboarding. These change how every subsequent demo lands.
2. Next, analysis free at point of use: GeoParquet import/export,
   then the DuckDB-WASM analysis surface with recipe fallback. Ship
   with an honest note that the analysis ran in the visitor's own
   browser at no server cost.
3. Then 3D phases a and b (COPC, then 3D Tiles + terrain via deck.gl
   overlay on the existing map, no separate scene app).
4. In parallel, as a slow burn: time-travel UI over the observation
   log, because it is unique, and MCP Phase 2 toward the
   permission-inheriting agent.
5. Keep OGC conformance moving underneath it all (it is the
   positioning moat and shrinks QGIS-plugin scope per surface).

Tile cache phases 1-3 and Playwright smoke tests should ride along
as engineering hygiene regardless of the order above.

The one-sentence version: measure less against incumbent feature
lists and more against what a self-hosted, unmetered platform can
uniquely offer, wrapped in a UI polished enough to be taken
seriously.
