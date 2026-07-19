# Spatial Analysis Workbench: research + discussion (2026-07-19)

A deep dive on what an easy-to-use, high-value spatial analysis surface
should be for GratisGIS, and how to build it on what we already have.
Research-backed; sources inline. This is a discussion doc for future
dev, not a committed plan.

## The thesis, sharpened

Esri's constraint is its revenue model. It meters analysis two ways:
by consumed credits (routing, enrichment, per-1,000-feature vector
ops, imagery and deep-learning by the pixel) and by paid desktop
extensions (Spatial Analyst gates contours, viewshed, solar, and all
of hydrology; Image Analyst gates imagery deep learning; 3D Analyst
gates 3D line-of-sight). A self-hosted portal pays none of that at the
margin. So the workbench should lead with exactly the operations Esri
charges for, because that is where "we do this for free" lands hardest.

Two honest nuances the research surfaced, so we do not overclaim:
- ArcGIS Online already gives Create Viewshed, Create Watersheds, and
  Trace Downstream for zero credits. The credit contrast is sharpest
  on routing/drive-time, GeoEnrichment, and per-1,000-feature vector
  overlay. The extension contrast (desktop) is sharpest on solar,
  contours, and imagery deep learning.
- "AI feature extraction with no GPU" is real, but mostly by shipping
  prebuilt open datasets and interactive in-browser models, not by
  running large segmentation jobs on the box. We should be precise
  about which is which.

## How it fits what we already have

We are unusually well positioned because three pieces already exist:

1. The in-browser DuckDB-WASM Analyze panel (#175) with save-as-layer.
   The entire vector-analysis tier runs there with zero server cost.
2. The recipe / derived-layer system: server-run, parameterized
   geoprocessing that outputs a new layer. Every heavy tool
   (terrain, hydrology, data fetch) is just a new recipe step that
   shells out to a bundled binary and imports the result as a
   `data_layer`. This is the async-background-job substrate the UX
   research says we need.
3. GeoParquet + DuckDB. The best open building-footprint datasets
   (Overture, VIDA) are cloud-native GeoParquet on public S3, which
   DuckDB can clip to an AOI by reading directly from S3 without
   downloading the planet. Feature extraction becomes a query.

So the workbench is less a new subsystem than a curated set of tools
layered onto these three, with a consistent UX.

## The capability menu, by feasibility tier

### Tier 1 — In-browser now (DuckDB-WASM spatial + turf.js, zero server)

Confirmed available in DuckDB's spatial extension, which is built for
the wasm target, so these run client-side in the Analyze panel:

- Buffer (`ST_Buffer`; planar, so reproject or use turf for lon/lat
  real-distance buffers), point-in-polygon (`ST_Contains`/`ST_Within`),
  spatial join (DuckDB 1.3+ has a dedicated `SPATIAL_JOIN` operator
  with an on-the-fly R-tree; a 58M x 310 join runs in ~29s), dissolve
  (`ST_Union_Agg`, prefer `ST_MemUnion_Agg`/`ST_CoverageUnion_Agg` on a
  small box), clip/erase (`ST_Intersection`/`ST_Difference`), centroid
  and guaranteed-inside label point (`ST_PointOnSurface`), hull and
  Voronoi.
- Density without statistics: the DuckDB `h3` community extension
  (built for wasm) does hex-binning by pure aggregation, the cheapest
  scalable "where is it hot" surface; plus MapLibre's native heatmap
  layer for a visual KDE.
- Clustering: DBSCAN/KMeans via turf in-browser for small N.

Sources: https://github.com/duckdb/duckdb-spatial/blob/main/docs/functions.md
· https://duckdb.org/2025/08/08/spatial-joins ·
https://duckdb.org/community_extensions/extensions/h3 · https://turfjs.org/docs

Gaps to route server-side: indexed nearest-neighbor at scale (PostGIS
`<->` KNN-GiST; DuckDB has no `<->` operator), geodesic buffers/distance
(PostGIS `geography`), very large dissolve, DBSCAN on big point sets.

### Tier 2 — Server CPU via recipe/derived-layer (cheap, bundled binaries)

- Contours: `gdal_contour` (single pass, writes straight to
  PostGIS/OGR). Hillshade/slope/aspect/TRI/TPI: `gdaldem` (trivial,
  effectively free). Already in our GDAL.
  https://gdal.org/en/stable/programs/gdal_contour.html
- Viewshed: `gdal_viewshed` with a bounded `-md` radius is near
  interactive (sub-second to a few seconds at a 5 km radius on 10-30 m
  DEM). Whole-DEM or cumulative viewshed → async. GRASS `r.viewshed`
  only for very large DEMs. Requires a projected CRS and ideally a DSM
  (surface, includes buildings) not bare earth.
  https://gdal.org/en/stable/programs/gdal_viewshed.html
- Hydrology, one-click "delineate the watershed for this clicked
  point": WhiteboxTools pipeline — `BreachDepressionsLeastCost` →
  `D8Pointer` → `D8FlowAccumulation` → `SnapPourPoints` (critical, or a
  click yields a bogus micro-basin) → `Watershed` → vectorize; optional
  `ExtractStreams` for the stream overlay. WhiteboxTools is a single
  MIT-licensed Rust binary, best CPU throughput, trivial to bundle and
  shell out to (pysheds is a pure-Python alternative but GPL-3.0).
  https://www.whiteboxgeo.com/manual/wbt_book/available_tools/hydrological_analysis.html

Recommended engines: GDAL for the everyday terrain derivatives and
single-point viewshed; WhiteboxTools as a second bundled binary for
hydrology, shade, and extended geomorphometry; GRASS reserved only for
solar and huge-DEM viewshed (it is heavy to bundle: a full install plus
a location/mapset session per job).

### Tier 3 — Prebuilt-data feature extraction (the "AI", no GPU)

The pragmatic AI story. Fetch-and-clip open datasets as new layers:

- Building footprints: Overture Buildings (GeoParquet on public S3,
  ~2.6B, ODbL/CDLA) or the VIDA Google+Microsoft+OSM union (2.7B,
  GeoParquet/PMTiles). DuckDB clips an AOI directly from S3 — this is a
  query, not a download, and reuses our DuckDB engine.
  https://docs.overturemaps.org/guides/buildings/ ·
  https://source.coop/vida/google-microsoft-osm-open-buildings
- Land cover: ESA WorldCover 10 m global, CC-BY, COG tiles on public
  S3. https://registry.opendata.aws/esa-worldcover-vito/
- Tree canopy % and impervious surface %: USGS NLCD, 30 m, US, public
  domain GeoTIFF. https://www.mrlc.gov/data/type/nlcd-tree-canopy-cover
  · https://www.mrlc.gov/data/type/urban-imperviousness

All are COG/GeoParquet, so GDAL `/vsicurl` or DuckDB window a bbox
without pulling whole tiles. This gives "tree canopy for my county",
"impervious surface for this parcel", "buildings in this AOI" as
one-click layer fetches, with no model and no GPU.

### Tier 3b — Interactive in-browser segmentation (no server GPU)

The single most compelling "AI" feature a no-GPU portal can ship:
click-to-extract-a-building. MobileSAM (5M params, ~3s/image on a Mac
i5 CPU) and SlimSAM run in the browser via transformers.js (ships
SlimSAM, WebGPU-accelerated in v3) or ONNX Runtime Web; SAM2 runs fully
in-browser via ORT-Web + WebGPU. The winning pattern is precompute the
image embedding once, then the decoder runs at millisecond speed per
click. Inference happens on the visitor's machine, so the portal needs
no GPU. Fits our existing ONNX-in-browser posture.
Sources: https://github.com/opengeos/segment-geospatial ·
https://github.com/ChaoningZhang/MobileSAM ·
https://huggingface.co/posts/Xenova/240458016943176

### Tier 4 — Heavy / optional, cap or gate it

- Solar / insolation: GRASS `r.sun` is the open-source Area Solar
  Radiation equivalent (the Spatial-Analyst-gated Esri tool). Realistic
  CPU path: precompute horizon angles once with `r.horizon`, then r.sun
  per sampled day, threaded, chunked. Honest flag: full-annual,
  high-res, city-scale solar is genuinely doubtful CPU-only (tens of
  minutes to hours); cap the area/resolution and run async with
  progress/cancel. r.sun is CPU/OpenMP, not GPU, so the answer is "cap
  and queue", not "buy a GPU". WhiteboxTools `TimeInDaylight` is a
  lighter drop-in for a "how many sunlit hours" shade widget.
  https://grass.osgeo.org/grass-stable/manuals/r.sun.html
- Drive-time / isochrones: self-host Valhalla with a pre-built
  state/country OSM tile extract (tiles are memory-mapped, ~2-4 GB
  serve RAM, lowest of the routers; build tiles offline). pgRouting is
  the no-extra-service option since we already run PostGIS. Avoid OSRM
  (no isochrones) and openrouteservice (per-profile RAM blowup) on a
  small box. This is the concrete replacement for Esri's 0.5-credit
  service areas. https://valhalla.github.io/valhalla/
- Real hot-spot statistics (Getis-Ord Gi*, Moran's I): no SQL or JS
  implementation exists; needs a Python/PySAL worker. Lead with H3
  density + heatmap as the default; reserve Gi* for an optional tier.
- Tree counts from imagery: DeepForest (RGB tree-crown detector) runs
  CPU-only but slow (~7 min/km²), so small-AOI async jobs only.
- Optional GPU tier (clearly labeled, never default): full-scene
  semantic segmentation of large mosaics, SAM ViT-H auto-masking over
  big areas, torchgeo fine-tuning, fast large-area DeepForest.

## Input data: fetch-and-cache

DEMs: Copernicus GLO-30/GLO-90 (free, COG, public S3, no key), USGS
3DEP (public domain; 1 m where flown), OpenTopography global-DEM API
(free key, rate-limited 50/day non-academic — a convenience clip
service, not a bulk pipeline). Imagery: NAIP (public domain, COG,
requester-pays so pull in-region or pay egress), Sentinel-2 L2A (free,
COG, Element84 Earth Search STAC), Maxar Open Data (CC-BY-NC — flag the
non-commercial limit in the UI). All COG, so we window a bbox and cache
it as a portal item; hard air-gap deployments pre-stage tiles. Sources:
https://registry.opendata.aws/copernicus-dem/ ·
https://opentopography.org/developers ·
https://earth-search.aws.element84.com/v1/api.html

## The asymmetric-vs-Esri wins (what to lead with)

| Capability | How Esri meters it | Our free equivalent |
| --- | --- | --- |
| Drive-time / isochrones / service areas | 0.5 credits per service area (per break x location) | Valhalla or pgRouting, self-hosted |
| Buffer/overlay/dissolve/clip/join/centroid | 1 credit per 1,000 features | DuckDB-WASM in-browser or PostGIS |
| Find Hot Spots / Density | 1 credit per 1,000 features | H3 density now; PySAL Gi* optional |
| GeoEnrichment (demographics) | 10 credits per 1,000 attributes | Free Census TIGER/ACS join |
| Contours | Spatial Analyst extension | `gdal_contour` |
| Viewshed | free in AGO, extension on desktop | `gdal_viewshed` |
| Area Solar Radiation | Spatial Analyst extension | GRASS `r.sun` |
| Watershed / flow / streams | free in AGO, extension on desktop | WhiteboxTools |
| Imagery deep learning | Image Analyst + by-pixel credits | prebuilt datasets + in-browser SAM |
| Building footprints | Esri content / credits | Overture / VIDA via DuckDB |

Credit rates from Esri's own docs:
https://doc.arcgis.com/en/arcgis-online/analyze/credits-analysis-mv.htm

## UX: making heavy geoprocessing feel easy

From Felt, QGIS Processing, and AGO:

1. Command-palette discovery (Cmd/Ctrl+K, type "Buffer"), not a nested
   toolbox. One "Analyze" entry plus search on plain tool names.
2. One tool = one plain-language card: name, a one-line "use this
   when...", and an explicit Input geometry → Output geometry. No
   jargon.
3. Auto-generated parameter form from the tool's declared schema, a
   live log/progress pane, and async execution so the map stays
   interactive (this is exactly our recipe/derived-layer job model).
4. Non-destructive: every run produces a new layer with sensible
   default symbology and never mutates the source, so tools chain.
5. Occupy AGO's "Estimate credits" slot with "Free" (or a runtime
   estimate). Same reassurance, opposite message.
6. Instant client-side (DuckDB-WASM / turf) for small-N vector; async
   server job for raster, routing, and large-N, with an up-front "clip
   to your area first" nudge on big inputs.

## Recommended build sequence

Cheapest and highest-value first, each phase building on the last and
on existing architecture.

Phase 1 — In-browser vector workbench. Extend the DuckDB-WASM Analyze
panel from raw SQL into a small set of one-click tools (buffer, spatial
join, clip/erase, dissolve, nearest, centroid, H3 density, cluster)
with the plain-language card UX and save-as-layer output. Zero server
cost; directly monetizes the "free where Esri meters per feature"
story; reuses everything from #175. The guided query builder (#176) is
the same UX surface.

Phase 2 — Server terrain + hydrology toolkit as recipe steps. Bundle
WhiteboxTools (single binary) alongside GDAL. Ship contours,
hillshade/slope/aspect, bounded viewshed, and one-click watershed
delineation, plus DEM fetch-and-cache (Copernicus/3DEP COG windowing).
These are the extension-gated Esri wins and all CPU-cheap.

Phase 3 — Prebuilt-data feature extraction. Fetch-and-clip layers for
buildings (Overture/VIDA via DuckDB), land cover (WorldCover), tree
canopy and impervious (NLCD), plus interactive in-browser
click-to-extract via MobileSAM/SlimSAM. The "AI" story with no GPU.

Phase 4 — Heavy / optional tier. Solar (r.sun, capped + async),
isochrones (Valhalla), tree counts (DeepForest async), Getis-Ord hot
spots (PySAL worker), and a clearly-labeled optional GPU tier for
large-area deep learning.

The immediate next build (the DuckDB spatial extension, self-hosted for
the WASM analysis panel) is literally the foundation of Phase 1: it is
what turns the Analyze panel from attribute-only SQL into spatial SQL.

## Open questions for discussion

- How hard is the air-gap requirement? Fetch-and-cache from public S3
  covers most deployments; a true air-gap needs an admin pre-stage
  step. Do we support both, or treat online-fetch as the norm with a
  documented offline path?
- Is an optional GPU tier worth building the plumbing for, or do we
  stay strictly CPU/browser and lean on prebuilt datasets + in-browser
  models for all "AI"?
- Python worker: several high-value items (PySAL hot spots, DeepForest,
  heavier segmentation) want Python. Do we add a Python analysis worker
  to the stack, or hold the line at Node/Rust-binary and defer those?
- Which three tools would you want first? My vote: buffer + spatial
  join (Phase 1, instant), watershed-from-a-click (Phase 2, the
  "wow, and Esri gates this" moment), and building-footprint fetch
  (Phase 3, the AI-adjacent quick win).
