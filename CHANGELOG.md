# Changelog

All notable changes to GratisGIS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
versioning policy, including what counts as a breaking change before
v1.0.0, is in [docs/VERSIONING.md](./docs/VERSIONING.md).

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
