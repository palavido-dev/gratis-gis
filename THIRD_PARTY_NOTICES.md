# Third-party notices

GratisGIS. Copyright (C) 2026 Matt Palavido.
Licensed under AGPL-3.0-or-later; see [LICENSE](./LICENSE).

npm dependencies declare their own licenses in their package metadata
and are not repeated here. This file covers third-party materials that
are bundled in this repository or fetched into GratisGIS builds
outside of npm, with their licenses and provenance.

## iD editor tagging schema (OSM preset catalog)

- Source: [openstreetmap/id-tagging-schema](https://github.com/openstreetmap/id-tagging-schema)
- License: ISC (the preset JSON and code). The presets describe
  OpenStreetMap tagging, and any OSM data fetched with them is
  ODbL (see the OpenStreetMap entry below).
- What we ship: a converted snapshot committed at
  `apps/portal-web/content/osm/preset-catalog.json`. The committed
  snapshot was generated 2026-05-24 from upstream `main`; future
  syncs run `scripts/sync-osm-presets.mjs`, which pins an upstream
  release tag (currently `v7.0.1`) and records repo, ref, license,
  and generation time in the file's `source` block.

## MobileSAM ONNX decoder weights

- Source: the [MobileSAM](https://github.com/ChaoningZhang/MobileSAM)
  project.
- License: Apache-2.0.
- What we ship: nothing in the repository. The mask-decoder weights
  (`mobilesam-decoder.onnx`) are downloaded at portal-web image build
  time from this project's pinned model release
  (`models-mobilesam-v1`) and verified against a sha256 hash; see
  `apps/portal-web/Dockerfile`. They power the magic-outline tool in
  the browser via onnxruntime-web.

## DuckDB WASM extensions

- Source: the official DuckDB extension repository at
  `extensions.duckdb.org` ([DuckDB](https://duckdb.org/)).
- License: MIT.
- What we ship: nothing in the repository. The `spatial`, `parquet`,
  `json`, and `icu` WASM extensions are mirrored at portal-web image
  build time into `public/duckdb-ext/` so production visitors fetch
  them from the portal's own origin; see `apps/portal-web/Dockerfile`.

## Map point-symbol icons derived from lucide

- Source: [lucide](https://lucide.dev/) (`lucide-react`), ISC-licensed.
- What we ship: SVG bodies of selected lucide glyphs, extracted into
  the generated registry at
  `apps/portal-web/src/app/items/[id]/map/map-icons.ts` by
  `scripts/gen-map-icons.cjs`, used as map point symbols.

## OpenStreetMap data

- Source: [OpenStreetMap](https://www.openstreetmap.org/) via the
  Overpass API (OSM overlays and the OSM toolset) and optionally a
  self-hosted Nominatim geocoder.
- License: Open Database License (ODbL). Data fetched from OSM
  carries the attribution "(c) OpenStreetMap contributors", which the
  map UI displays wherever OSM-derived layers render.

## Bundled sample data (Randolph County, West Virginia)

- Sources: WV GIS Technical Center (wvgis.wvu.edu) and WV DNR,
  redistributed under the mapWV Terms of Use (public domain for
  reuse), and USDA Forest Service National Forest System Trails data
  (a US federal public-domain work).
- What we ship: the one-click sample workspace content under
  `apps/portal-api/content/samples/randolph`. Full provenance,
  per-dataset caveats, and processing notes are in
  [docs/sample-data.md](./docs/sample-data.md).
