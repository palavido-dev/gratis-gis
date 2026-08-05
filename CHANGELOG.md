# Changelog

All notable changes to GratisGIS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
versioning policy, including what counts as a breaking change before
v1.0.0, is in [docs/VERSIONING.md](./docs/VERSIONING.md).

## [0.9.8] - 2026-08-05

A safe upgrade from 0.9.7, and the first release with a way to reach
the portal from outside a browser.

**Upgrade note:** this release adds a database table (`api_key`).
Migrations run automatically on API boot as usual, but if you keep a
golden snapshot for demo resets, refresh it after upgrading.

### Added

- **API keys** (#219). Create a key at Profile -> API keys and use it
  as a bearer token from scripts, notebooks, scheduled jobs, or CI.
  A key acts as the person who created it, so sharing rules and
  geographic limits apply exactly as they do in the browser. Keys can
  be marked read-only, can be given an expiry, and are never accepted
  on admin endpoints or for managing other keys. Tokens are stored as
  a one-way hash and shown only once.
- **A Python client** (#220), in `clients/python`. Connect with an API
  key, read a layer as GeoJSON, and write features back, with
  automatic batching under the portal's per-request limit. One
  dependency.

### Fixed

- The MCP server no longer asks you to copy a session token out of
  browser developer tools. Use a read-only API key instead, which does
  not expire mid-session.
- Documentation described personal access tokens that had never been
  implemented. It now describes what actually ships.

## [0.9.7] - 2026-08-03

A safe upgrade from 0.9.6. Full-resolution terrain derives at any
extent, a terrain on/off toggle, and two visibility fixes.

### Added

- Chunked elevation processing (#208). Hillshade, elevation, and
  height-above-ground layers no longer hit the fixed size cap: any
  area builds at full resolution in bounded-memory chunks that
  combine into one seamless surface. Builds that cannot finish
  inside the server's time budget are refused up front with an
  estimate (operator-tunable GRID_* settings), and the building
  state reports real chunk progress.
- 3D on and off is now a toggle that keeps your elevation stack.
  Turning 3D off just flattens the view; the surfaces and their
  ordering are exactly as you left them when you turn it back on.
- The admin housekeeping page gains a "Broken references" card
  (#217): items pointing at other items that no longer exist (or
  sit in the trash) are listed with links, instead of rendering as
  silent holes in maps.

### Fixed

- An expired sign-in no longer shows the signed-in navigation. The
  portal chrome now follows the same session truth as the header
  and banner, so a dead session sees the public page with a sign-in
  prompt rather than a sidebar full of links that would not work.
- A manual golden snapshot no longer leaves the demo's tester
  workspace unassigned until the next nightly reset.

## [0.9.6] - 2026-08-03

A safe upgrade from 0.9.5. Multi-image imagery mosaics, and a
seeder fix that keeps sample-content references stable.

### Added

- Imagery mosaic (#199). Pick several aerial images in one upload
  (or "Add more images" on an existing imagery layer) and the
  portal combines them server-side into one seamless layer. Where
  images overlap, the most recently added wins. The source images
  are kept, so coverage can grow later without re-uploading
  anything; adding images re-composes over the full set. Builds
  are estimated before a byte uploads and refused when they cannot
  finish inside the server's job window (operator-tunable MOSAIC_*
  settings); a failed or partial upload can be retried without
  re-transferring what already made it.

### Changed

- The 3D terrain stack moved out of the basemap menu into its own
  collapsible section at the bottom of the map's layers panel.
  Terrain affects every layer, not just the basemap, and its
  top-wins ordering now reads exactly like the layer list above
  it. The basemap menu is basemaps only again.

### Fixed

- Sample-content items now get the same id every time they are
  seeded (#217). Previously a purged sample item came back under a
  new id, and any hand-built map referencing it silently lost that
  layer. Existing items keep their current ids.

## [0.9.5] - 2026-08-02

A safe upgrade from 0.9.4. Maps can now compose several elevation
layers into one terrain surface.

### Added

- Elevation mosaic (#211). A map's 3D terrain is now an ordered
  STACK of elevation layers instead of a single pick. The server
  composes terrain tiles per pixel across the stack, so two lidar
  surveys that cover different areas both extrude in the same map,
  and where surveys overlap the one nearer the top of the list
  wins. A single-entry stack keeps the existing in-browser path and
  costs the server nothing. Works in saved maps and scratch maps,
  signed in and anonymous.
- Layers remember their ground truth (#211). Derived layers
  (hillshade, steepness, visibility) and point clouds carry a
  reference to their matching elevation layer. Adding one to a map
  offers to bring that terrain along, and a layer's menu gains
  "Use this layer's elevation", which adds its elevation layer to
  the map's terrain stack.
- The elevation profile tool follows the terrain stack, sampling
  the same surface the map is standing on.

### Changed

- The point cloud page's derive section is now called "Elevation
  and shading" and groups its actions more clearly (#212).

### Internal

- First Playwright end-to-end suite: an e2e workspace with 11
  anonymous-path specs, plus a daily production smoke workflow.
- Terrain tiles ride the shared tile cache with the same overload
  backoff as vector tiles; the COG reads go through GDAL's /vsis3
  directly against MinIO.

## [0.9.4] - 2026-08-02

A safe upgrade from 0.9.3. Lidar ingest hardening, honest test
coverage, and small trust fixes.

### Fixed

- Multi-tile lidar uploads no longer lose everything to one bad
  round-trip. Tiles upload three at a time with automatic retry on
  transient failures; a tile that still fails is reported by name,
  and you can retry just the failures or start the merge with what
  made it and add the rest later.
- A point-cloud worker restart no longer leaves an interrupted
  merge's partial downloads on the scratch disk. The worker sweeps
  abandoned job directories at startup, keyed on the job table's own
  liveness, so a crash loop cannot ratchet the volume toward full.
- The portal now ships a favicon and Apple touch icons, so browsers
  and link previews stop receiving 404s for them.

### Added

- Merges are estimated before they start. The upload panel shows
  "N tiles, M GB, roughly H hours" before you commit gigabytes, a
  merge that cannot finish inside the server's time budget is
  refused up front with advice instead of dying at the timeout
  hours later, and the building state shows the estimate. The rates
  are operator-tunable and re-derivable from each completed merge's
  logged stats.
- The install doctor reports point-cloud scratch capacity against
  the merge sizing rule, and the deployment guide documents how to
  size the disk.

### Internal

- The PostGIS-backed engine and search-index test suites now run in
  CI against a real database through the production driver adapter,
  with a guard that fails the build if they would silently skip.
  Reverting the v0.9.3 feature-insert fix now turns CI red, which is
  the property that was missing when it shipped broken.

## [0.9.3] - 2026-07-30

A safe upgrade from 0.9.2. Nothing here requires a configuration
change: the additions are demo and operator tooling that stays off
unless you turn it on.

### Fixed

- Saving features works again. The advisory lock the write path takes
  asked PostgreSQL for rows from a function that returns nothing, and
  the database driver could not deserialize that, so the transaction
  rolled back. Every insert path was affected: form submissions,
  imports, OpenStreetMap saves, and sample data seeding.
- A portal whose sign-in has expired no longer presents itself as
  signed in. The header showed a name and avatar while the API had
  already downgraded the same session to anonymous, so private items
  quietly disappeared with no explanation. The header now offers Sign
  in, matching the banner that was already there.
- `infra/deploy.sh` parses `.env.prod` instead of sourcing it through
  bash. Sourcing expanded the values, so anything containing a dollar
  sign (a bcrypt hash, for one) silently became something else, and a
  secrets file was arbitrary code in a root deploy. Parsing follows
  the same rules `docker compose --env-file` uses, so the scripts and
  compose always agree. The golden snapshot and restore scripts use
  the same loader.

### Security

- The bundled `pmtiles` binary is built against golang.org/x/text
  0.39.0, past CVE-2026-56852. Upstream still pins the vulnerable
  version, so the image build upgrades the dependency itself and
  asserts the result.

### Added

- Optional traffic analytics for a public demo deployment: Caddy
  access logs and Keycloak login events collected into a SQLite store
  outside the nightly reset, rendered as a static dashboard at
  `/_stats` behind basic auth. Off by default. `STATS_USER`,
  `STATS_HASH`, `CADDY_LOG_DIR` and `ANALYTICS_DIR` are documented in
  `infra/.env.prod.example`; the default credentials cannot
  authenticate, so an untouched deployment exposes nothing.
- A demo sign-in theme that lists the shared tester accounts, and
  seeding that gives those testers an owned and shared workspace after
  each nightly reset. Both are demo-instance tooling.

## [0.9.2] - 2026-07-26

### Added

- The deployed version now shows on the landing page footer and at the
  bottom of the signed-in user menu, linking to that release's notes.
  Deploys stamp the exact ref (a release tag, or a describe string for
  between-releases builds), and /api/portal-info reports the same
  value for API clients.

## [0.9.1] - 2026-07-26

### Fixed

- The trash listing now serializes the lean owner projection like the
  live list and the detail read. The pre-snapshot demo purge keys its
  keep-or-purge decision on the owner and correctly refused to run
  against rows without one, which blocked the golden refresh after the
  v0.9.0 deploy.
- The purge script requests the API's real page cap instead of a
  parameter that never existed, and documents the fail-safe direction
  when an org outgrows one page.

## [0.9.0] - 2026-07-26

The first tagged release. GratisGIS has been developed in the open on
`main` until now; from this release forward the installer and the
deploy script track release tags, and
[docs/UPGRADING.md](./docs/UPGRADING.md) describes how self-hosters
move between them.

### Added

Everything is new in a first release. What ships, briefly:

- The portal: organizations, users, groups, folders, an item catalog,
  and sharing with row, column, and geographic limits, on top of an
  append-only observation-log engine with Cedar geometry-aware
  authorization.
- Web maps authored on PostGIS-backed data layers with vector tile
  rendering, drawings, scratch maps, live PostgreSQL/PostGIS
  connections, and print/PDF layouts.
- Forms and field data collection: form authoring, submissions, and an
  offline-capable field PWA.
- Web apps: viewer, editor, and custom widget apps built in the App
  Builder, with seeded app and print templates.
- Analysis: derived-layer tools, a visual tool builder with OSM as a
  first-class source, an in-browser analyze panel, and a server-side
  analysis workbench (contours, viewshed, steepness, height above
  ground, elevation profiles, SAM-assisted outline capture).
- 3D: COPC point cloud upload, merging, and streaming, plus terrain
  built from lidar elevation layers.
- Interoperability: OGC API Features, Tiles, Styles, and Records under
  `/api/public/ogc`; GeoParquet import and export; an ArcGIS Online
  content importer and Esri WebMap JSON import/export; an MCP server
  (`apps/portal-mcp`). A QGIS plugin lives in its own repository.
- Operations: single-host Docker Compose deployment with a one-command
  installer, guided setup, health checks, admin backup and restore,
  five UI languages, and one-click sample data.

### Changed

- `infra/install.sh` and `infra/deploy.sh` now check out the newest
  release tag by default instead of tracking `main`. Setting `GG_REF`
  overrides the choice with a tag, branch, or commit sha.
- Breaking: `GET /api/items` now returns the narrow item shape by
  default and paginates (default page 500, hard cap 1000). Pass
  `full=1` for full `data_json` payloads and page with `limit` and
  `offset`.
- The service worker replays queued field edits through one offline
  queue with Background Sync, trims the runtime tile cache, and purges
  per-user caches on sign-out.
- Observation partition maintenance runs on a schedule inside
  Postgres (the pg_partman background worker), and premade future
  partitions drop from 24 to 4, cutting how many partitions each hot
  query probes.
- Infrastructure hardening: deploys, golden snapshots, restores, and
  the nightly demo reset share one lock; snapshot and restore verify
  their artifacts before any destructive step; dependent services wait
  on a Keycloak healthcheck; container memory budgets are sized to the
  reference 8 GB box.

### Fixed

- Ghost features: filtered reads (vector tiles, feature search, the
  geocoder, derived layers, bbox and clip reads, exports) now collapse
  each feature to its latest version before applying filters, so
  deleted and superseded versions no longer resurface.
- Retried feature creates that carry a client-supplied id are
  recognized and deduplicated under an advisory lock instead of
  inserting duplicate features.
- Raster protocols (PMTiles, COG) are re-asserted at map init rather
  than trusted from a cached flag, and production web builds use
  webpack, ending the dual maplibre-instance tile failures.
- OGC API Features paging emits `next` links again and no longer
  reports a misleading `numberMatched`.
- Imports: replace-mode truncation runs inside the COPY transaction so
  a failed replace rolls back; stale-job recovery runs periodically;
  cancelled jobs stop reporting phantom inserted rows.
- Point clouds: merge timeouts are configurable, scratch space is
  checked up front, worker output no longer deadlocks on a full pipe,
  and concurrent API writes are no longer clobbered.
- Analysis jobs carry a heartbeat and a reclaim sweep, so a killed
  worker no longer strands jobs as running forever, and queued or
  running jobs can be cancelled.
- Housekeeping gained a reconciliation sweep that removes orphaned
  uploads left in object storage by crashed jobs.
- Feature search and the geocoder can run on per-field trigram indexes
  (admin rebuild action) instead of full scans.
- Folder edits can send an optimistic-concurrency precondition and get
  a 409 instead of silently overwriting a concurrent save.
- Map: terrain rebuilds when a different DEM is picked, drawings
  survive basemap swaps, vector and GeoJSON sources keep their caches
  across style-only changes (no blink on opacity drags), and assorted
  popup, selection, and refetch races are fixed.
- Sessions: a failed token refresh is treated as signed out, so public
  pages fall back to the anonymous view instead of erroring.

### Security

- SSRF hardening: server-side fetches of user-supplied URLs
  (thumbnails, geocoding, the ArcGIS Online importer) revalidate every
  redirect hop and block internal address ranges.
- Stored XSS closed: uploaded SVGs are served as attachments, response
  disposition derives from the actually served content type, and
  serves carry `nosniff`.
- Object storage keys for tile layers and feature attachments are
  pinned to their expected prefixes, and serving reads by key through
  the S3 SDK instead of stored URLs.
- Cross-organization gaps closed in group administration, comment
  editing and deletion, and feature attachments.
- Zip ingestion runs in-process with traversal and symlink rejection,
  decompression and entry caps, and per-entry CRC checks.
- The web proxy rejects dot segments before allowlist matching.
- The Keycloak master realm is blocked at the edge, the materialized
  realm import file is no longer world-readable, and a root
  `.dockerignore` keeps secrets out of image build contexts.
- Dependency updates for published CVEs: Next.js 16.2.11, next-auth
  4.24.15, sharp, fast-uri, postcss, brace-expansion, tar, and the
  `@hono/node-server` override.

[0.9.2]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.2
[0.9.1]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.1
[0.9.0]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.0
