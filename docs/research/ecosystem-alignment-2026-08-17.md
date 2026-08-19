# Ecosystem alignment research, 2026-08-17

Prompted by the FOSS4G NA 2026 schedule: where is the current going, and
where should GratisGIS swim with it rather than against it.

Four deep dives: Mergin Maps sync, STAC, OGC API / pygeoapi, and the
BTAA "geoportal to platform" work. Everything below was verified by
fetching specs, docs and source; uncertainties are marked.

---

## The four headlines

1. **STAC is the no-brainer, and the payoff is bigger than expected.**
   QGIS has had **native STAC support in core since 3.42** (Data Source
   Manager, browsing, spatial/temporal filters, footprints on canvas).
   A compliant endpoint puts GratisGIS rasters into stock QGIS **with no
   plugin at all**. Phase 1 is one to two days.
2. **Our OGC surface makes claims that are not true**, and one of them
   returns wrong answers rather than an error. This is a correctness
   bug, not a missing feature.
3. **We are one route change away from being discoverable by QGIS's
   bundled MetaSearch plugin**, because our OGC API Records is served
   at a path no conforming client looks in.
4. **Mergin Maps solved the compare-and-set problem we knowingly
   shipped without**, and their answer is small: a monotonic version per
   layer plus the client's base version on push.

---

## 1. Mergin Maps and geodiff

Repos: [geodiff](https://github.com/MerginMaps/geodiff) (**MIT**),
[server](https://github.com/MerginMaps/server) (AGPL-3.0-**only** plus a
CLA, so reference material rather than a source),
[qgis-plugin](https://github.com/MerginMaps/qgis-plugin) (GPL-3.0),
[python-api-client](https://github.com/MerginMaps/python-api-client) (MIT).
Docs: [synchronisation](https://merginmaps.com/docs/manage/synchronisation/),
[changeset format](https://github.com/MerginMaps/geodiff/blob/master/docs/changeset-format.md).

**Their model.** A project directory versioned linearly `v1..vN`. geodiff
does row-level SQL comparison of two GeoPackages (ATTACH one as `aux`,
three queries per table). The client keeps a **full pristine copy** of
every versioned file as a "basefile", which is what makes three-way
rebase possible. Conflicts rebase automatically, last-writer-wins, with
a JSON conflict artifact written alongside; unrebaseable cases become a
"conflicted copy" file and the user carries on.

### Borrow

- **A monotonic version integer per data layer, and a push that carries
  the client's base version.** Their server returns 409
  `ProjectVersionExists` when the submitted version is stale. That is
  exactly the compare-and-set we documented as impossible in #25 and
  worked around with detect-only conflict checking. It costs one integer
  column incremented per accepted write batch.
- **A delta endpoint.** `GET .../delta?since=<version>`. We currently
  re-download an entire layer's GeoJSON just to read `_edited_at` per
  feature: O(n) network per sync on a 24k-feature layer. **Our
  `observation` table already IS a changeset log**; the only missing
  piece is a monotonic cursor exposed over it. We are structurally
  closer to their model than it looks.
- **A `check_only` dry run** before committing an upload, so "your copy
  is stale" fires before anything transfers.
- **A conflict artifact rather than only a modal.** Today "skip those"
  discards the user's work with no recoverable record. Even keeping the
  dialog, the losing side should be written somewhere.
- **Chunk dedupe by content hash**, complementing our feature-level
  `globalId` dedupe.
- **WAL discipline.** They checkpoint before reading and treat the
  presence of a `-wal` file as "assume modified". We read the baseline
  table with raw sqlite; if the .gpkg is open in QGIS, saved-but-
  uncheckpointed rows live in the `-wal` and a raw read can miss them.
  **This is a latent bug in our sync.**

### Deliberately do differently

- **Keep the per-layer unit.** Their project-directory unit is what
  forces schema freezing, whole-file copies and conflicted copies of the
  .qgz.
- **Keep hashes, not a full basefile.** geodiff needs the complete
  "before" GeoPackage on disk, doubling storage per clone. Ours is ~64
  bytes per feature. The cost is that we get two-way detection only,
  never three-way merge. That is an acceptable trade.
- **Keep UUID globalIds.** They make insert/insert collisions
  structurally impossible, so we never need geodiff's PK remapping and
  never inherit its unremapped-foreign-key bug (#39).
- **Do not adopt whole-layer-only sync.** Mergin has no bbox or filtered
  sync for features and no plan for one. We already serve MVT and paged
  features by extent, so bbox-scoped clone and delta is somewhere we can
  beat them rather than copy them.
- **Do not require identical schemas.** A schema change is a hard error
  for them, degrading to a conflicted copy. Our schema edits are pure
  metadata on the observation log. Preserve that.

### Hazard worth writing down

geodiff compares geometry as **raw blob bytes** (`memcmp`, no epsilon),
so identical WKB with different GeoPackage envelope flags reads as an
edit ([issue #107](https://github.com/MerginMaps/geodiff/issues/107),
open since 2019). **Our `hash_geometry()` has the same property and is
safe only because baseline and live are both read through
`read_local_features()`.** If a clone is ever rewritten by a different
producer (GDAL vs QGIS vs libgpkg), every feature will read as edited.
Note it in the code.

**Do not adopt geodiff itself.** It diffs two GeoPackages or two Postgres
schemas; our server side is an append-only log it cannot represent. The
transferable parts are the changeset semantics and the rebase conflict
taxonomy, not the library.

---

## 2. STAC

Specs: [stac-spec 1.1.0](https://github.com/radiantearth/stac-spec),
[stac-api-spec 1.0.0](https://github.com/radiantearth/stac-api-spec)
(separate repos, separate version numbers).
Minimal item: [simple-item.json](https://github.com/radiantearth/stac-spec/blob/master/examples/simple-item.json).

**Build it ourselves in NestJS. Do not adopt pgstac or stac-fastapi.**
Our STAC Items are a pure read-side projection of rows we already have:
nothing to store, nothing to sync. Adopting the Python stack would mean
a second service, a duplicated metadata table, and re-implementing our
per-item authorization in another language. `src/public/ogc/` already
gives us the landing-page/conformance/paging shape to copy, and
`records.controller.ts` is ~80% of a STAC catalogue with different key
names.

**Conformance classes to declare:** Core, Collections, Features, Item
Search. **Skip CQL2/Filter** — QGIS does not use it, and it is a parser
plus a safe SQL translation layer, the single largest cost item.

**Extensions:** `projection` (nearly free: `tile-conversion.ts` already
runs `gdalinfo -json` and parses `geoTransform`; ingest always warps to
EPSG:3857 so `proj:code` is a constant) and `web-map-links` (has `xyz`
and `pmtiles` rel types matching our two endpoints exactly).

**Prerequisite: fix #16.** `data_json.bbox` is already populated for both
COG and PMTiles uploads; only the top-level `item.bbox` column is empty.
Items can be rendered today, but `/search?bbox=` cannot be indexed
without it.

**Known wart to decide on:** `datetime` would map from `uploadedAt`,
which is ingest time, not acquisition time. Everyone falls back to this
and it validates, but a search for "summer 2024 imagery" returns 2026
answers. A capture-date field on upload is the honest fix; not a v1
blocker.

**Auth is already solved.** `JwtAuthGuard` accepts `ggk_...` keys on the
same Bearer header, and read-only keys are already restricted to
GET/HEAD/OPTIONS, exactly the STAC read surface. Public surface at
`/api/public/stac`, authed mirror at `/api/stac` scoped by
`SharingService.visibleWhere`, copying `ogc/authed-features.controller.ts`.
Caddy proxies `/api/*` straight to portal-api, so **no BFF allowlist
entry is needed**.

Validators worth wiring in:
[stac-node-validator](https://github.com/stac-utils/stac-node-validator)
(Node, fits CI) and
[stac-api-validator](https://github.com/stac-utils/stac-api-validator).

**Unverified:** whether QGIS's filter panel drives `/search` or
`/collections/{id}/items` (implement both from one query builder), and
whether QGIS passes auth through to the GDAL asset fetch (Lutra list it
as future work, so private rasters may browse but fail to load — our own
plugin remains the bridge).

---

## 3. OGC API, and pygeoapi

[pygeoapi](https://github.com/geopython/pygeoapi) is **MIT**, Python,
YAML-configured. Reference Implementation for Features, Tiles and EDR.

**What "Reference Implementation" actually means** (narrower than it
sounds, per [OGC's own wiki](https://github.com/opengeospatial/cite/wiki/Reference-Implementations)):
passed CITE for *at least core*, runs a permanently public test
endpoint, re-certified annually. Multiple can co-exist. It is a real
signal of rigour, not a statement of canonical status.

**Treat pygeoapi as a peer to learn from, not to deploy.** It is a
publishing server driven by a YAML file; we are a portal with per-item
Cedar decisions, share tiers, geo limits and row scoping. Putting it in
front of our data would mean re-implementing our authorization in a
second process in a second language. Worth mining for: how a
CITE-passing conformance declaration is shaped, how they run CITE in CI,
and their Records provider design.

### Our own defects, found by reading our code

1. **`ogcapi-records-1/1.0/conf/core` is not a real conformance class.**
   The actual classes are `conf/record-core`, `conf/record-collection`,
   `conf/searchable-catalog`, `conf/json`, `conf/sorting` and others. We
   declare a URI that does not exist.
2. **Three Tiles classes are declared with no matching endpoint**
   (`conf/tilesets-list`, `conf/dataset-tilesets`,
   `conf/geodata-tilesets`): `/collections/{id}/tiles` does not exist.
3. **Unknown query parameters are silently ignored.** `?datetime=...`
   returns 200 with unfiltered data. That is a **wrong answer**, not a
   missing feature, and it is the worst failure mode in the surface.
   Features Core requires a 400.
4. Content types are misdeclared: `/items` advertises
   `application/geo+json` in its own links but serves
   `application/json`; style docs advertise
   `application/vnd.mapbox.style+json` and serve `application/json`.
5. `docs/ogc-api-strategy.md:46` documents the tile route as
   `{z}/{x}/{y}`; the code correctly uses
   `{tileMatrix}/{tileRow}/{tileCol}`. The doc is wrong.

**An over-declared `conformsTo` is worse than a short one**, because
clients branch on it.

### The free credibility win

The CITE test suite is public and runnable locally:

```
docker run --network=host ogccite/ets-ogcapi-features10
# then http://localhost:8081/teamengine/ pointed at our landing page
```

ETSs exist for Features, Tiles, Processes and EDR. **None exist for
Records, Maps, Styles or Coverages**, so nobody can claim certification
there. Testing and registration are free; only the trademarked
compliance mark carries a fee. Do this before considering formal
certification — passing first, claiming second.

### OGC API Records: one route change from a bundled QGIS client

Records is the standardised "here is a catalogue of stuff" API, and it
is the most natural fit of any OGC API to what a portal uniquely is.
Every other OGC API describes *data*; Records describes *the portal*.

**The blocker is purely the path.** The standard mandates
`/collections/{catalogId}/items`; we serve `/records`. QGIS's
**MetaSearch plugin — bundled with QGIS by default** — splits its
configured URL on the literal string `"/collections/"`, and OWSLib
discovers catalogues by fetching `/collections` and keeping entries
where `itemType == 'record'`. So it cannot find us, for two reasons.

We already emit `numberMatched` from a real count, `numberReturned`,
`timeStamp`, `q`, `limit`, `offset`, `sortby`, per-record links and
Polygon geometry from `item.bbox`. The delta is: mount at the collection
path, set `itemType: "record"`, add a `bbox` parameter, wire `owner`
through (`ITEM_SELECT` does not currently select the owner relation).

Caveat: MetaSearch's "Add Data" button keys off a legacy service-type
list (`WMS`, `WFS`, `ESRI:ArcGIS:FeatureServer`, `FILE:GEO`...) with
**no OAPIF entry**, so one-click add needs a `FILE:GEO` GeoJSON link.
That is a nudge to upstream QGIS, not a flaw on our side.

### Styles and Maps

**Styles is still a draft** after nine years, with no ETS. But it does
not invent a style language — it standardises the API *around* style
documents and treats Mapbox Style JSON as a first-class encoding. So the
answer to "should we align rather than invent our own style JSON" is:
**we already have, and we were right to.** Keep the draft URIs, just be
honest that they are draft.

**Maps: skip.** It is approved, but it needs server-side raster
rendering we do not do, and the clients that want images overwhelmingly
speak plain WMS.

### Priority order

1. Truthfulness fixes above (Tier 1, small, correctness).
2. Run the CITE suite. It is the negative control: if it passes before
   the fixes, my reading of the code is wrong.
3. Records at the collection path. Unlocks a bundled QGIS client.
4. Features Part 3 (CQL2 filter + queryables), then Part 5 (schemas),
   which makes GDAL/OGR type-stable instead of guessing from page one.

---

## 4. BTAA, GeoBlacklight and Aardvark

[BTAA API](https://github.com/geobtaa/api) (**MIT**, FastAPI + ParadeDB +
Elasticsearch), [GeoBlacklight](https://github.com/geoblacklight/geoblacklight)
(Apache-2.0, Rails + Solr),
[Aardvark schema](https://opengeometadata.org/ogm-aardvark/).

The talk title in the schedule is not theirs; their own deck is "BTAA
Geodata API: Turning a Portal into a Pipeline" (Geo4Lib, Jan 2026).

**Their motivation, verbatim** from the
[tech plan](https://gin.btaa.org/library/tech-plan-2025/): the portal
"functions as a silo, requiring all access and use to flow through the
Geoportal", and the move addresses "our reliance on a single developer's
specialized skill set and tying all of our resources to a single piece
of open-source software". That is a solo-maintainer risk argument
written down publicly by people in the same position. Worth reading.

**We are further along the standards path than they are.** Their OGC
Records facade went live first but returns `"timeStamp": "92ms"` (should
be RFC 3339), `numberMatched: 0` alongside `numberReturned: 1` (breaks
paging), `geometry: null` throughout, and doubled URL prefixes in
`alternate` links. Ours emits a real count, ISO timestamps and real
geometry.

### Aardvark: yes as an export projection, no as an internal model

It is a Solr-suffix-encoded *discovery* schema for a library catalogue:
no owner, no org, no sharing, no folders, no editing, no styles, no
forms. Strictly a subset of our needs plus library-specific baggage.

But as a ~150-line projection next to `records.controller.ts` it makes a
GratisGIS portal harvestable by any GeoBlacklight instance. Federation
then costs nothing extra, because OpenGeoMetadata's harvest mechanism is
literally **a git repo of .json files**.

Mapping notes: `dcat_bbox` is `ENVELOPE(W,E,N,S)` — different order from
our `[w,s,e,n]`. `dcat_centroid` is `"lat,lon"`, latitude first.
`dct_accessRights_s` is a strict two-value vocabulary, so org and
private both collapse to `Restricted` (fine, since a public projection
should only emit public rows). `gbl_resourceClass_sm` is a strict
7-value enum our 29 item types collapse into.

**`dcat_theme_sm` is a ready-made 21-value theme taxonomy** — and
`records.controller.ts:293` already carries a TODO saying we do not yet
curate one. Adopting theirs costs a string union.

**Blocker worth knowing:** `dct_references_s`, the entire interop
surface, has **no OGC API Features URI** in its vocabulary — only WMS,
WFS, WCS, WMTS. A GeoBlacklight instance could preview our COGs and
download our GeoJSON, but could not preview our vector layers. Closing
that needs a PMTiles export (clean; PMTiles is already a first-class GBL
viewer) or WMS (which we deliberately do not serve). Proposing an OGC
API Features reference URI upstream is a small, high-leverage
contribution that benefits every OGC-API-native portal.

### Ideas worth stealing

1. **`meta.ui`: a server-computed presentation block.** They precompute
   `viewer{protocol, endpoint, geometry}`, `downloads[]`, `thumbnail_url`
   and citations once on the server, so web, CLI, QGIS and MCP all
   consume the same answer. **We derive layer construction twice** —
   `portal-item-layers.ts` in portal-web and again in the QGIS plugin. A
   server-side viewer hint would collapse that duplication. This is the
   single most directly applicable idea in the whole research pass.
2. **`gbl_displayNote_sm` with severity prefixes** (`Danger:`,
   `Warning:`, `Info:`, `Tip:`) rendering as a coloured box. A good
   answer to "this layer is provisional / superseded".
3. **"Unlisted" as distinct from deleted** — hidden from search, still
   reachable by direct link. Useful for per-layer children.
4. **A relations vocabulary**: `replaces` / `isReplacedBy` makes
   annual-release datasets coherent. We have `derived_layer` and
   folders but no supersession story.
5. **Citation export** (BibTeX/RIS/JSON-LD). Cheap, and the one thing an
   academic user asks for that commercial portals do poorly.

### On "QGIS access", we are ahead, structurally

There is **no BTAA plugin published on plugins.qgis.org** (0 results for
both "BTAA" and "geoblacklight"). What exists is unpublished,
`experimental=True`, hardcodes an internal dev host with
`session.verify = False`, uses Qt5 `exec_()` and subclasses `QThread`
rather than `QgsTask` — precisely the failure modes we already hit and
fixed.

The structural point: **their plugin can only speak generic protocols
because BTAA does not own the data.** We own ours, so a bespoke plugin
that publishes from the canvas, clones offline and syncs is doing things
a catalogue plugin structurally cannot. Writing our own was right.

---

## What I would actually do, in order

1. **OGC truthfulness fixes.** Small, and #3 is a wrong answer.
2. **Fix #16 (tile_layer bbox).** Now a prerequisite for two things,
   not just a nice-to-have.
3. **STAC phase 1.** One to two days for stock-QGIS discoverability.
4. **Records at the collection path.** A day, for a bundled QGIS client.
5. **Layer version counter + delta endpoint.** Fixes the conflict
   weakness we knowingly shipped, and makes sync O(changes).
6. **Aardvark projection.** ~150 lines for library-ecosystem reach.
7. **`meta.ui` viewer hint.** Collapses duplicated layer construction.
