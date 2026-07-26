# Deep learning, raster, and lidar tooling: an open source survey (2026-07-20)

A deep survey of well-vetted open source projects in deep learning on
imagery, raster and terrain analysis, lidar and point cloud analysis,
and remote sensing pipelines that GratisGIS could wrap, integrate, or
mine for ideas. The reference bar for caliber was
[raster-vision](https://github.com/azavea/raster-vision); as covered
below, the field has moved since that project's heyday, and part of
the value of this survey is naming where the center of gravity is now.

Every maintenance claim below was checked against live GitHub, PyPI,
or project pages during this session (2026-07-20), not recalled from
memory. License claims for the serious candidates were verified
against the actual LICENSE files. Where something could not be
verified, the doc says so instead of guessing.

## How to read this: the integration surface

Everything is scored against the workbench rails that shipped this
week: an `analysis_job` Postgres queue polled by worker containers.
The first worker is a micromamba (conda-forge) image carrying PDAL
2.10, GDAL 3.13, untwine, and Python 3.14. It already turns COPC
point clouds into bare-earth DEM COGs and hillshades, and every
raster output automatically becomes a portal layer (COG, tile
pyramid, map layer, 3D terrain drape). A new tool is: a new job kind,
a worker container (or an addition to the existing one), params
validation, and a plain-language panel. Tier gating
(ANALYSIS_TIERS) already exists, so CPU-light, CPU-heavy, and
GPU-tier tools can coexist in one design.

Hard guardrails applied throughout: self-hosted only (no cloud APIs,
no SaaS inference, no phoning home), licenses usable from an AGPL
project's separate worker containers (Apache, MIT, BSD, GPL, LGPL,
AGPL all fine since workers are separate processes talking over a
queue), model weights licenses checked separately from code, and CPU
viability on a 4-core box preferred, GPU optional.

A recurring pattern worth naming up front: for almost every capability
there is a permissively licensed, CLI-driven, conda-forge-packaged
engine that slots into the existing worker with near-zero integration
work. The portal's job is choosing the right engine per tool, writing
honest plain-language framing, and riding the existing COG rails.

## Part 1: Deep learning on aerial and satellite imagery

### The frameworks: raster-vision has slowed, TorchGeo is the center of gravity

**Raster Vision** ([azavea/raster-vision](https://github.com/azavea/raster-vision),
Apache-2.0, ~2.2k stars). The reference example itself is the
cautionary tale. The last release is
[0.31.1, August 2024](https://pypi.org/project/rastervision-core/),
and repo activity since has been dependency bumps (last push September
2025 at time of checking). Azavea, its steward, merged into
[Element 84](http://www.azavea.com/projects/raster-vision/) in 2023.
It is not archived and the docs remain excellent, but it has had no
feature release in about two years. Verdict: mine it for pipeline
design ideas (chip sampling, sliding-window prediction with overlap,
vector-to-raster label handling), do not build on it.

**TorchGeo** ([torchgeo/torchgeo](https://github.com/torchgeo/torchgeo),
MIT). This is where the energy went. Formerly a Microsoft project, it
[formed its own governing organization](https://www.osgeo.org/foundation-news/torchgeo-0-8-0-release/)
with the 0.8.0 release (November 2025) to guarantee independence, and
is an OSGeo community project. [0.8.0](https://github.com/torchgeo/torchgeo/releases/tag/v0.8.0)
added 28 new pretrained model weights and a ChangeDetectionTask;
0.9.0 followed in January 2026. It packages datasets, samplers that
understand CRS and pixel alignment, pretrained sensor-specific
backbones (including SatlasPretrain and Sentinel-2 weights), and
Lightning task classes for classification, segmentation, regression,
and change detection. Python, PyTorch; inference is CPU-viable for
modest areas, training wants GPU. For GratisGIS this is the library a
future "run a model over my imagery" worker should be written
against, because it solves the annoying geospatial parts (windowed
reads, reprojection, stitching predictions back into a georeferenced
raster) that generic vision libraries ignore.

**TerraTorch** ([IBM/terratorch](https://github.com/IBM/terratorch),
Apache-2.0). IBM's fine-tuning and benchmarking toolkit for
geospatial foundation models, built on PyTorch Lightning, with a
[1.0 release in 2025](https://research.ibm.com/blog/simplifying-geospatial-ai-with-terra-torch-1-0)
and a [toolkit paper](https://arxiv.org/abs/2503.20563). Its model
factory pairs any supported backbone (Prithvi, TerraMind, Clay,
Satlas, plain timm backbones) with segmentation, classification, or
pixel-regression heads, driven by a YAML config, no code. If
GratisGIS ever offers a "fine-tune on your own labeled data" tier,
this is the engine; until then it matters as the standard way to run
the IBM/NASA model family.

Practical takeaway: GratisGIS should not build training UX in the
foreseeable future. The near-term wins are inference-only tools using
already-trained models with clean licenses, below.

### Geospatial foundation models with open weights

The honest framing first: foundation models are backbones. Except for
a few published fine-tuned heads, they do not do anything out of the
box; someone fine-tunes them per task. Their near-term portal value
is (a) specific released task models built on them, like canopy
height, and (b) embeddings for similarity search. With that caveat,
the license landscape is unusually good right now:

| Model | Org | Weights license | Notes |
| --- | --- | --- | --- |
| [Prithvi-EO-2.0](https://github.com/NASA-IMPACT/Prithvi-EO-2.0) | NASA + IBM + Julich | Apache-2.0 ([HF](https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M)) | 300M/600M ViT, HLS time series, released Dec 2024, fine-tunes via TerraTorch |
| [TerraMind 1.0](https://github.com/IBM/terramind) | IBM + ESA + Julich | Apache-2.0 ([HF](https://huggingface.co/ibm-esa-geospatial/TerraMind-1.0-base)) | any-to-any generative EO model, Apr 2025, tiny/small/base/large |
| [Clay v1.5](https://github.com/Clay-foundation/model) | Clay Foundation / Dev Seed | Apache-2.0 (code and weights, [docs](https://clay-foundation.github.io/model/)) | 632M ViT, multi-sensor, strong embeddings story |
| [SatlasPretrain](https://github.com/allenai/satlaspretrain_models) | Allen AI | code Apache-2.0, weights ODC-BY (attribution) | Sentinel-2 and aerial backbones; also distributed inside TorchGeo |
| [HighResCanopyHeight](https://github.com/facebookresearch/HighResCanopyHeight) | Meta + WRI | Apache-2.0 (code and weights per README) | tree height from RGB aerial imagery; see lidar section |
| AlphaEarth Foundations | Google DeepMind | weights NOT released | only [precomputed embeddings](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL) (CC-BY 4.0) via Earth Engine, GCS, and [source.coop](https://developers.google.com/earth-engine/guides/aef_on_gcs_readme); usable as a data source, not self-hostable as a model |

Flags: SatlasPretrain weights are ODC-BY, which requires attribution
in the UI, easy but must be remembered. AlphaEarth is the one
headline model that fails the self-hosting guardrail; its annual
10 m embedding rasters could still be ingested as plain data for a
"find places that look like this" tool, since the dataset itself is
CC-BY. One caution on Meta's canopy model: the March 2026 CHMv2
release builds on DINOv3, whose own weights ship under a custom Meta
license; the v1 model (DINOv2-based) is the one verified Apache here.
Re-verify the exact checkpoint license before shipping v2.

### Segment-anything for geospatial work

**segment-geospatial (samgeo)**
([opengeos/segment-geospatial](https://github.com/opengeos/segment-geospatial),
MIT, [JOSS paper](https://joss.theoj.org/papers/10.21105/joss.05663)).
Qiusheng Wu's package wraps Meta's SAM family for georeferenced
rasters: automatic mask generation, interactive point/box prompts,
and text prompts (via Grounding DINO), with outputs as georeferenced
masks and vectors. Very active: v1.2.0 December 2025 with further
releases into 2026. This is the highest-leverage wrapper in the whole
DL space because it turns "segment this drone photo" into a few lines
against files GratisGIS already stores.

Model licensing within the family matters:

- SAM 1 and [SAM 2 / 2.1](https://github.com/facebookresearch/sam2):
  code and checkpoints Apache-2.0. Safe to bundle and ship.
- [SAM 3](https://github.com/facebookresearch/sam3) (November 2025,
  concept-prompted detection and tracking, ~840M params): released
  under a custom "SAM License", permissive-leaning but not OSI, with
  use restrictions. Treat as optional and clearly labeled if ever
  offered; default to SAM 2.1.

Resource honesty: SAM encoders on CPU take seconds per image tile.
That is workable for interactive assisted digitizing (one view at a
time, precomputed embeddings) and small-area jobs, but wall-to-wall
segmentation of a county ortho is GPU-tier work.

### Extraction models that work out of the box on CPU

**DeepForest** ([weecology/DeepForest](https://github.com/weecology/DeepForest),
MIT, [Methods in Ecology and Evolution paper](https://besjournals.onlinelibrary.wiley.com/doi/10.1111/2041-210X.13472)).
Detects individual tree crowns (and has bird/wildlife models) in RGB
aerial imagery with a prebuilt model trained on NEON data. Very much
alive: 2.0.0 November 2025, [2.1.0 February 2026](https://github.com/weecology/DeepForest).
Weights are on Hugging Face under MIT
([weecology/deepforest-tree](https://huggingface.co/weecology/deepforest-tree)).
RetinaNet-scale, so CPU inference is genuinely viable for
neighborhood-to-town areas. Slot-in: a "count the trees" job that
takes an ortho layer plus an area and returns a point or box layer.

**Detectree2** ([PatBall1/detectree2](https://github.com/PatBall1/detectree2),
MIT, verified from LICENSE; [Ball et al. 2023](https://patball1.github.io/detectree2/)).
Mask R-CNN (Detectron2, Apache-2.0) crown delineation, strongest in
dense canopies where DeepForest boxes overlap badly. Active commits
and PRs through 2025, docs at v2.1.1. Heavier than DeepForest;
GPU-preferred for real areas. Good second-tier option where polygons
per crown matter.

**OmniCloudMask** ([DPIRD-DMA/OmniCloudMask](https://github.com/DPIRD-DMA/OmniCloudMask),
MIT, verified; [Remote Sensing of Environment 2025 paper](https://doi.org/10.1016/j.rse.2025.114694)).
Sensor-agnostic cloud and shadow segmentation that generalizes across
Sentinel-2, Landsat, and high-res sensors. PyPI at 1.7.x, PyTorch,
CPU-viable. The companion [S2Mosaic](https://github.com/DPIRD-DMA/S2Mosaic)
(MIT) shows the full recipe for cloud-free Sentinel-2 composites.
This is the quality gate that makes any satellite-imagery tool
trustworthy.

Buildings deserve a special note. For most US counties the right
answer is still prebuilt open data (Overture and similar GeoParquet
datasets, already covered by the workbench research doc) rather than
running extraction models. Where a user brings their own drone ortho,
the practical open pipeline is samgeo segmentation plus footprint
cleanup with [Building-Regulariser](https://github.com/DPIRD-DMA/Building-Regulariser)
([PyPI](https://pypi.org/project/buildingregulariser/), same shop as
OmniCloudMask), which squares wobbly outlines to principal
directions, the open equivalent of Esri's regularize tool.
Road extraction remains research-grade in open source; nothing met
the "well vetted" bar this pass.

### Change detection with deep learning

**Open-CD** ([likyoo/open-cd](https://github.com/likyoo/open-cd),
Apache-2.0 verified; [ACM MM 2025 toolbox paper](https://dl.acm.org/doi/10.1145/3746027.3756881))
is the most complete model zoo for bitemporal change detection, built
on the OpenMMLab stack. **torchange**
([Z-Zheng/pytorch-change-models](https://github.com/Z-Zheng/pytorch-change-models))
is the lighter research library alternative. Two cautions: the
OpenMMLab dependency chain pins aging PyTorch versions (an
operational headache in a long-lived worker image), and every DL
change method assumes co-registered same-sensor pairs, which real
county imagery rarely is without preprocessing. TorchGeo 0.8's native
ChangeDetectionTask may become the cleaner path. GPU-tier; the CPU
change story lives in Part 4.

## Part 2: Classical raster and terrain analysis

### What GDAL 3.13 already gives us for free

The current worker image ships tools that map one-to-one onto
credit-gated or extension-gated features elsewhere, with zero new
dependencies:

- [gdal_contour](https://gdal.org/en/stable/programs/gdal_contour.html):
  elevation contour lines from any DEM COG, straight to a vector layer.
- [gdal_viewshed](https://gdal.org/en/stable/programs/gdal_viewshed.html):
  visibility from an observer point (Wang, Robinson, White 2000
  algorithm), with observer height and radius parameters.
- gdaldem: slope, aspect, terrain ruggedness, color relief (hillshade
  already shipped).
- gdal_calc / gdal raster calc: band math for indices on any
  multiband raster the user uploads.
- gdal_grid, gdal_proximity, gdal_fillnodata, gdal_polygonize:
  interpolation, distance surfaces, void fill, raster-to-vector.

These are the cheapest real tools in the entire survey.

### GRASS GIS 8.5 plus actinia

[GRASS 8.5.0 released 2026-05-08](https://grass.osgeo.org/news/2026_05_08_grass_8_5_0_released/)
(GPL-2+), the product of two years of work: a new `grass.tools`
Python API with NumPy in/out, JSON output across dozens of tools, and
rewritten docs, with NSF-supported development. GRASS remains the
deepest scientifically validated toolset in open source GIS:
`r.watershed` (depression-tolerant flow accumulation and basins),
`r.viewshed`, `r.sun` (the Hofierka and Suri solar model, the
standard open implementation of solar radiation),
`r.cost`/`r.walk`/`r.drain` (least-cost paths with anisotropic
walking cost), plus interpolation and imagery modules. Official
Docker images exist, and the new Python API makes worker scripting
much less painful than the old location/mapset ceremony.

**actinia** ([actinia-org/actinia-core](https://github.com/actinia-org/actinia-core),
GPL-3 verified, maintained by mundialis with a
[release in July 2025](https://pypi.org/project/actinia-core/), OSGeo
community project) wraps GRASS in a REST processing API. GratisGIS
already has its own queue, so actinia is less something to deploy
than a design reference: its process-chain JSON format is a mature
answer to "how do you describe a multi-step GRASS job over HTTP," and
worth reading before finalizing the recipe-step vocabulary for
terrain tools.

### WhiteboxTools: MIT-licensed depth, with an honest status flag

[WhiteboxTools](https://github.com/jblindsay/whitebox-tools) (MIT,
verified from LICENSE) is John Lindsay's Rust platform with roughly
550 tools, exceptionally strong in exactly the areas GratisGIS wants:
hydrology (the
[BreachDepressionsLeastCost](https://www.whiteboxgeo.com/manual/wbt_book/available_tools/hydrological_analysis.html)
implementation of Lindsay 2016 is the best open answer to road
embankments and culverts in lidar DEMs), geomorphometry, lidar
utilities (IndividualTreeDetection, NormalizeLidar,
ClassifyBuildingsInLidar), and the clever TimeInDaylight
shadow-fraction solar tool. Single static binary, trivial to add to
the worker image, no runtime dependencies.

The status flag: the last open-core release is
[v2.4.0](https://github.com/jblindsay/whitebox-tools/releases), which
dates to May 2023 (the R frontend that wraps it reached CRAN in
[November 2023](https://whiteboxr.gishub.org/news/index.html)), and
Whitebox Geospatial Inc.'s commercial energy visibly goes into paid
extensions and the proprietary Whitebox Workflows product. The open
core is stable, hugely cited, and fine to pin, but assume slow fixes.
Mitigation: treat WBT as one engine behind portal-owned tool
definitions, with GRASS as the substitute bench for most of the same
operations.

### SAGA GIS and Orfeo ToolBox

**SAGA** ([SourceForge](https://sourceforge.net/projects/saga-gis/),
GPL-2+, [Conrad et al. 2015 method paper](https://gmd.copernicus.org/articles/8/1991/2015/))
is extremely actively released: 9.9.0 in
[July 2025](https://sourceforge.net/p/saga-gis/news/2025/07/saga-990-released/),
through 9.12.0 by April 2026. `saga_cmd` is fully headless. Its
unique draws for GratisGIS: the canonical SAGA Wetness Index,
potential incoming solar radiation, and a huge geomorphometry
library. Worth adding to the image only when a specific SAGA-only
method is wanted; otherwise it overlaps GRASS/WBT.

**Orfeo ToolBox** ([orfeo-toolbox.org](https://www.orfeo-toolbox.org/),
Apache-2.0, CNES) is the remote sensing heavyweight: streaming-based
processing of arbitrarily large imagery on bounded RAM, large-scale
mean-shift segmentation, pansharpening, radiometric indices, texture
features, and classic supervised classification (random forest, SVM)
with sampling and confusion-matrix tooling built in. Latest stable is
[9.1.1, March 2025](https://www.orfeo-toolbox.org/otb-release-9-1-0/),
with active development in 2026 and OTB 10/11 on the public roadmap.
Its command-line applications fit the worker pattern exactly, and its
classifier applications are the most defensible CPU path to a
"land cover from imagery" tool without any deep learning.

### The hydrology engine decision

Four options were checked:

- **WhiteboxTools**: best depression handling (least-cost breaching),
  D8/D-infinity/FD8 flow accumulation, watershed from pour points,
  stream extraction and ordering. Static binary. The recommendation.
- **GRASS r.watershed**: rock solid, actively maintained, handles
  depressions internally without preconditioning; the second opinion
  and long-term insurance.
- **pysheds** ([pysheds/pysheds](https://github.com/pysheds/pysheds),
  GPL-3+, [0.5 in August 2025](https://pypi.org/project/pysheds/)):
  clean numba-based Python; fine for scripting but adds nothing over
  WBT/GRASS for a worker.
- **TauDEM** ([dtarb/TauDEM](https://github.com/dtarb/TauDEM), GPL):
  scientifically foundational (Tarboton's D-infinity), but the last
  release is 5.3.8 from October 2020 and it drags an MPI stack;
  effectively dormant, do not adopt. RichDEM was not pursued: its
  algorithms (Barnes's priority-flood family) are already available
  through the engines above, and its maintenance was not verified
  this pass.

The full suite (fill or breach, flow direction, flow accumulation,
snap point to stream, watershed, downstream trace, stream network)
composes from WBT primitives, which matches the primitives-not-tools
direction in the workbench doc.

### Viewshed, solar, least-cost

Viewshed has three interchangeable engines already discussed
(gdal_viewshed today; GRASS r.viewshed and WBT visibility tools for
multi-observer variants later). Solar has two honest CPU options:
GRASS `r.sun` for real irradiance units (kWh per square meter, the
validated model) and WBT TimeInDaylight for an intuitive
"fraction of the day in sun" surface that is cheaper to explain and
compute; both work on the DSMs the lidar pipeline can already
produce. Least-cost paths and corridors come from GRASS
`r.cost`/`r.drain`, useful later for things like trail or utility
line planning.

## Part 3: Lidar and point clouds beyond PDAL's defaults

### Canopy height and vegetation structure: already within reach

The single cheapest high-value lidar tool: a canopy height model.
PDAL 2.10 already in the image does this with
[filters.hag_nn or filters.hag_dem](https://pdal.io/en/stable/stages/filters.hag_nn.html)
(height above ground) plus writers.gdal, or simply DSM minus the DTM
the elevation job already computes. Output rides the existing COG to
tile pyramid to 3D-drape rails untouched. The refinement to know
about, not necessarily ship first: pit-free CHM generation
(Khosravipour et al. 2014), implemented as the spike-free algorithm
in the lidR ecosystem.

### Individual tree detection

Three credible CPU paths, in increasing sophistication:

1. **CHM local maxima + watershed segmentation**: the classic
   approach, available today via WBT
   [IndividualTreeDetection](https://github.com/jblindsay/whitebox-tools/releases)
   (added in v2.3) on the point cloud, or a small numpy/scikit-image
   step on the CHM. Good enough for street trees and open canopy.
2. **lidR / lasR algorithms** ([r-lidar/lidR](https://github.com/r-lidar/lidR),
   GPL-3; [r-lidar/lasR](https://github.com/r-lidar/lasR), GPL-3):
   the reference implementations of li2012 point-based segmentation
   and dalponte2016 crown growing. lidR is the standard forestry
   lidar package; since 2024 both are maintained by the r-lidar
   company after university funding ended, with active doc updates
   into 2026. lasR is the production rewrite: a C++ pipeline engine
   with R and Python APIs that reads COPC directly and is built for
   terabyte collections. Adding an R runtime to a worker is real
   weight; lasR's Python API makes it the plausible integration
   route if forestry tooling becomes a focus. Otherwise treat lidR
   as the idea mine.
3. **DeepForest on the ortho** (Part 1): where good RGB imagery
   exists, crowns from imagery complement lidar counts.

### Point cloud classification cleanup

**OpenPointClass** ([uav4geo/OpenPointClass](https://github.com/uav4geo/OpenPointClass),
AGPL-3) is the pragmatic winner: fast, memory-efficient CPU semantic
classification (ground, vegetation, buildings, and custom classes)
using random forest or gradient boosting over multi-scale geometric
features, from the OpenDroneMap author. Train once on a
locally-labeled tile, apply across the collection. This is the
realistic "fix the misclassified points" tool for county lidar whose
vendor classification is poor. Deep point-cloud networks (the
Pointcept family and similar research stacks) exist but are GPU-tier
and were not license-verified this pass; OPC covers the practical
need.

### Change between lidar surveys

Two tiers. Tier 1 is DEM differencing: subtract two elevation COGs,
threshold, and report gain/loss; pure GDAL, ships now, and is what
most "what changed" questions actually need. The scientific upgrade
is **py4dgeo** ([3dgeo-heidelberg/py4dgeo](https://github.com/3dgeo-heidelberg/py4dgeo),
MIT verified, [SoftwareX paper](https://www.sciencedirect.com/science/article/pii/S2352711026001627),
1.x releases through 2025-2026): the reference implementation of M3C2
(Lague et al. 2013) and M3C2-EP, which measure change along surface
normals with per-point uncertainty, the right method for slopes,
riverbanks, and construction sites where straight DEM differencing
lies. C++ core with Python bindings, CPU-fine.

### Buildings from lidar

**roofer** ([3DBAG/roofer](https://github.com/3DBAG/roofer), GPL-3
verified) is the successor to TU Delft's geoflow (refactored in
summer 2024) and the engine behind the Netherlands'
[3DBAG](https://arxiv.org/pdf/2201.01191), which reconstructed LoD2
roof models for 10 million buildings. It requires footprint polygons
plus the point cloud, which GratisGIS can supply (Overture or parcel
footprints plus county lidar). This is a spectacular 3D-viewer
feature (real roof shapes instead of extruded slabs) rather than a
first-wave analysis tool. WBT's ClassifyBuildingsInLidar covers the
simpler task of labeling building points from footprints.

**Open3D** ([isl-org/Open3D](https://github.com/isl-org/Open3D),
MIT, [v0.19 January 2025](https://www.open3d.org/2025/01/09/open3d-v0-19-is-out-with-new-features-and-more-gpu-support/))
stays on the shelf as a library: registration/ICP for aligning scans,
meshing, and geometry metrics if a custom point cloud step ever needs
them. Not an end-user tool by itself.

## Part 4: Remote sensing pipelines: imagery in, answers out

### Ingest: the STAC path to "get imagery for my area"

The self-hosted-friendly stack is **pystac-client** for search,
**odc-stac** for loading results into xarray, and **rioxarray/dask**
for the math, all conda-forge packages in the active STAC ecosystem
([pystac](https://github.com/stac-utils/pystac) reorganized its
extensions in spring 2026, a sign of life, not decay). odc-stac sits
under the opendatacube umbrella
([docs](https://odc-stac.readthedocs.io/)); it and stackstac are
interchangeable for this purpose, and odc-stac has the more active
organizational home. On the publish side,
[rio-stac](https://github.com/developmentseed/rio-stac) generates
valid STAC items for COGs GratisGIS produces, relevant to the OGC/
STAC conformance direction already on the roadmap.

The data source that makes this a killer feature:
[Earth Search by Element 84](https://element84.com/earth-search/), a
free public STAC API over the AWS open data registry, including
[Sentinel-2 L2A as COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/),
no API key, active through 2025 (pipeline updates presented at FOSS4G
2025). A worker can search by the portal's area of interest, stream
only the needed windows from the COGs, mask clouds with
OmniCloudMask, and save a composite as a portal raster layer. That is
"fresh satellite imagery for my county, every week, for free" with no
vendor account, a capability small orgs assume requires a paid
subscription. It does require outbound internet from the worker, so
it should be an operator-enabled source, consistent with the existing
Overpass/OSM source precedent.

### Spectral indices

Indices are band math; the engineering is bookkeeping. The
[Awesome Spectral Indices catalog](https://github.com/awesome-spectral-indices/awesome-spectral-indices)
(Montero et al., published in Scientific Data, 2023)
is a machine-readable JSON list of 200+ published indices with
formulas, band mappings, and references; the right move is vendoring
the catalog as vocabulary and evaluating formulas with numpy in the
worker. The companion package
[spyndex](https://github.com/awesome-spectral-indices/spyndex) was
flagged inactive by dependency scanners as of May 2025, which is fine
because the catalog, not the package, is the durable asset. UI note:
per the no-jargon rule, indices ship as "plant health (NDVI)",
"water detection (NDWI)", "burn severity (NBR difference)", with the
acronym as the parenthetical, not the headline.

### Change detection, honestly tiered

CPU tier, defensible science, ships early: index differencing between
two dates (dNDVI for vegetation loss/gain, dNBR for burn severity
following the standard Key and Benson classification), plus DEM
differencing from Part 3. These are transparent, explainable, and
robust to the co-registration problems that break fancier methods.
GPU tier, later: Open-CD or TorchGeo change models for
building-level change from high-res pairs.

### Super-resolution: recommend against shipping

Verified caveat, not vibes: ESA's
[OpenSR project](https://github.com/ESAOpenSR) built
[opensr-test](https://github.com/ESAOpenSR/opensr-test) specifically
to measure hallucination in Sentinel-2 super-resolution, and the
popular [Satlas super-resolution](https://satlas.allen.ai/superres)
model (ESRGAN-based, open code) measures at the high end of the
hallucination scale in comparative testing, with Allen AI themselves
labeling outputs as sometimes incorrect. A portal whose users make
parcel and permitting decisions should not manufacture pixels. If it
ever ships, it ships as "enhanced display imagery" with a permanent
on-map disclosure, never as analysis input. Low priority.

## Part 5: Adjacent and exceptional

### OpenDroneMap: the sleeper hit for small organizations

[ODM](https://github.com/opendronemap/odm) (AGPL-3 verified) turns
overlapping drone photos into orthomosaics, DSMs, and point clouds,
exactly the inputs the rest of the workbench consumes.
[NodeODM](https://github.com/opendronemap/nodeodm) exposes it as a
REST processing node in a container, which maps onto the GratisGIS
worker pattern almost embarrassingly well: a "process my drone
photos" job kind that posts to a NodeODM sidecar and imports the
resulting ortho and DEM as portal layers. Counties increasingly own
drones and pay real money for exactly this processing. Two flags:
memory scales with photo count, so the demo box only handles small
surveys (tier-gate it), and an April 2026 governance split forked the
ecosystem (the OpenDroneMap nonprofit continues ODM/NodeODM; a
separate group rebranded a fork as ODX). Development on the
OpenDroneMap side remains active (commits within days of this
survey); pin to that side and watch how the split settles.

### exactextract: zonal statistics done right

[isciences/exactextract](https://github.com/isciences/exactextract)
(Apache-2.0, [0.3.0 December 2025](https://pypi.org/project/exactextract/),
C++ with CLI and Python bindings) computes zonal statistics using
exact cell coverage fractions instead of all-or-nothing cell centers,
the same rigor its R sibling exactextractr is loved for. This is the
engine for "summarize any raster inside any boundary layer":
average tree height per parcel, solar exposure per rooftop, elevation
statistics per district, feeding tables that dashboards and reports
already know how to render.

### ML-assisted digitizing: the browser decoder pattern

The standout interactive idea, proven by Meta's own demo
architecture: split SAM into its encoder and decoder ONNX graphs, run
the heavy encoder server-side once per map view (CPU: seconds), ship
the tiny decoder to the browser via onnxruntime-web, and every user
click returns a mask in tens of milliseconds with no server
round-trip. Public reference implementations:
[SAM-in-Browser](https://github.com/sunu/SAM-in-Browser),
[webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2), and
[an end-to-end SAM2 browser writeup](https://medium.com/@geronimo7/in-browser-image-segmentation-with-segment-anything-model-2-c72680170d92).
Pipe the mask through polygonization plus Building-Regulariser and
the result lands in the existing editor as a clean feature. This is
"click on a barn, get its outline," self-hosted, Apache-licensed end
to end, GPU-optional. It also degrades gracefully: on the demo box,
embeddings for known demo imagery can be precomputed offline, making
the demo feel instant.

### Engine quick reference

| Engine | License | Verified currency | Best at | Worker fit |
| --- | --- | --- | --- | --- |
| GDAL 3.13 | MIT/X | already shipped | contours, viewshed, dem math | in image today |
| GRASS 8.5 | GPL-2+ | 8.5.0 May 2026 | hydrology, solar, cost paths | add container |
| WhiteboxTools 2.4 | MIT | release 2023, stable | breaching, lidar utils, geomorphometry | single binary |
| SAGA 9.12 | GPL-2+ | Apr 2026 | wetness index, solar | add when needed |
| Orfeo ToolBox 9.1 | Apache-2.0 | Mar 2025, active repo | classification, segmentation, big imagery | CLI apps |
| PDAL 2.10 | BSD | already shipped | CHM, ground, gridding | in image today |
| py4dgeo 1.x | MIT | 2025-2026 releases | 3D change (M3C2) | pip install |
| exactextract 0.3 | Apache-2.0 | Dec 2025 | zonal statistics | pip install |
| OpenPointClass | AGPL-3 | active repo | point cloud classification | small C++ build |
| samgeo 1.2 | MIT | Dec 2025+ | SAM segmentation on rasters | pip + weights |
| TorchGeo 0.9 | MIT | Jan 2026 | DL inference/training scaffolding | pip, GPU-optional |
| OpenDroneMap | AGPL-3 | Jul 2026 commits | drone photo processing | NodeODM sidecar |

## The tiered shortlist

### Tier 1: high value, low lift, runs on the current CPU worker

Each of these is one job kind on existing rails, with the engine
already in the image or a single binary away. Names are draft
plain-language framing.

1. **Contour lines** (gdal_contour): "Draw elevation lines on any
   terrain layer." Days of work, permanent utility.
2. **Visibility** (gdal_viewshed): "See what is visible from a spot,
   at a chosen height." Tower siting, view protection, event
   planning. Introduces the pick-a-point job parameter the hydrology
   tools also need.
3. **Water flow suite** (WhiteboxTools): "Where does water come from"
   (click a culvert, get the upstream area that drains to it),
   "Where does water go" (trace the downstream path), and "Streams
   from terrain" (derive the stream network). The flagship of the
   tier; flood-prone lidar-rich West Virginia is the perfect demo
   geography for it.
4. **Tree height map** (PDAL, DSM minus DTM): "Turn lidar into a map
   of how tall everything is." Rides existing COG and 3D rails; the
   209M-point demo COPC makes it a showpiece. Follow-up: "Count the
   trees" via CHM local maxima or WBT.
5. **Plant health and other imagery formulas** (gdal_calc plus the
   Awesome Spectral Indices catalog): "Measure plant health from a
   multiband image you upload." Works on drone ortho uploads today,
   satellite imagery once ingest lands.
6. **What changed between surveys** (GDAL difference): "Compare two
   elevation layers and see what was built, dug, or eroded."
7. **Summarize inside boundaries** (exactextract): "Average any
   surface inside any boundary layer, into a table." Feeds reports
   and dashboards, quietly the most-used tool of the lot.

### Tier 2: medium lift, still CPU-honest

1. **Fresh satellite imagery for my area** (pystac-client, odc-stac,
   OmniCloudMask against Earth Search): cloud-free composites saved
   as layers; needs operator-enabled outbound access and quota logic.
2. **Land cover from imagery** (Orfeo ToolBox random forest, with
   training areas drawn in the portal): honest, explainable
   classification with an accuracy report, no GPU.
3. **Count and outline trees** (DeepForest, MIT weights; Detectree2
   for dense canopy): per-neighborhood scale on CPU.
4. **Fix point cloud labels** (OpenPointClass): retrain from a
   corrected sample area, apply to the collection.
5. **True 3D change** (py4dgeo M3C2): for slopes and banks where
   straight differencing misleads; report includes uncertainty.
6. **Burn and vegetation change** (dNBR/dNDVI differencing): two
   dates in, classified severity map out.
7. **Drone photos to maps** (NodeODM sidecar): tier-gated by memory;
   the tool that makes a small org's drone program self-sufficient.
8. **Solar exposure** (GRASS r.sun or WBT TimeInDaylight on the lidar
   DSM): "Find the sunniest rooftops and fields." (Borderline
   Tier 1 if TimeInDaylight is chosen.)

### Tier 3: GPU-tier headliners

1. **Click-to-outline digitizing** (SAM 2.1 encoder server-side,
   browser ONNX decoder, Building-Regulariser cleanup): flagship
   interactive AI, CPU-workable per view, GPU makes it effortless.
2. **Outline everything of a kind** (samgeo full-scene segmentation,
   optionally text-prompted via Grounding DINO, all Apache/MIT):
   "Find every building/pond/greenhouse in this image."
3. **Tree height without lidar** (Meta HighResCanopyHeight, Apache
   v1): canopy height from plain aerial RGB for places the lidar
   does not cover; verify the CHMv2/DINOv3 checkpoint license before
   using v2.
4. **Foundation-model tasks via TerraTorch** (Prithvi, TerraMind,
   Clay, all Apache-2.0 weights): flood extent, burn scars, crop
   segmentation from published fine-tuned heads; also "find places
   that look like this" similarity search from embeddings.
5. **Building-level change from image pairs** (Open-CD or TorchGeo
   change tasks): the credible GPU change story once pairs can be
   co-registered.

## Two calls

**Best next tool: Visibility (viewshed).** It is the shortest path
from the current codebase to a genuinely impressive analysis tool:
gdal_viewshed is already in the shipped GDAL 3.13 image, the input is
the DEM COG the elevation job already produces, and the output is one
raster-to-polygon step away from a normal portal layer. Just as
important, it forces exactly one new UX primitive, picking a point on
the map as a job parameter (plus an observer height field), and that
primitive is the same one the entire water flow suite needs next. Ship
visibility in days, then reuse its point-picking flow to ship
watershed and downstream trace as the flagship follow-up.

**Demo magnet: click-to-outline digitizing with SAM.** Clicking a
building on the county ortho and watching a clean, squared outline
drop into the editor reads as magic to every audience, from clerks to
GIS professionals, and no other self-hosted portal offers it. The
architecture is honest about the demo box: precompute encoder
embeddings for the golden demo imagery offline, so the live demo runs
the browser-side decoder only and feels instantaneous on 4 cores,
while self-hosters with GPUs get it everywhere on their own imagery.
Every component (SAM 2.1, samgeo, onnxruntime-web,
Building-Regulariser) is MIT or Apache licensed, weights included.
The runner-up magnet, watershed-from-a-click draped over the existing
3D terrain, is also strong and cheaper; if a single sprint must pick,
the watershed drape is the pragmatic choice and SAM digitizing is the
one people will screenshot.

## Cross-cutting adoption notes

- License posture is comfortable everywhere that matters: the
  recommended Tier 1/2 stack is entirely MIT, Apache, BSD, GPL (in
  separate worker containers), and AGPL (matching the portal's own
  license). The only weights requiring care: SatlasPretrain (ODC-BY
  attribution), SAM 3 (custom license, avoid by defaulting to
  SAM 2.1), and Meta CHMv2 (inherits DINOv3 terms, verify).
- The primitives framing from the workbench doc holds up against
  this survey: every recommended capability decomposes into typed
  raster/vector primitives with an engine behind each, and engines
  are swappable (viewshed and hydrology each have three credible
  implementations).
- Worker image strategy: keep the existing conda-forge image as the
  "classic geo" worker (GDAL, PDAL, WBT binary, exactextract,
  py4dgeo, GRASS if not split out) and put anything importing
  PyTorch in a separate "ml" worker image so the base image stays
  small and the GPU tier maps to a container, not a flag.
- Attribution and honesty in outputs: model-derived layers should
  carry a visible "computed by AI from imagery, verify before
  relying on it" note in the layer description by default. It costs
  nothing, matches the no-overclaiming style the portal already
  uses, and is what separates a trustworthy tool from a gimmick.
