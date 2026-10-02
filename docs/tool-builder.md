# Tool & Widget Builder

Status: partial. Tool items ship a recipe editor (named actions and
analysis recipes, including OSM). Materialising a recipe into a new
data layer or derived layer is still disabled. The node-graph UI
described below is not built. For what ships today, see the Status
section in [README.md](../README.md).

This page describes a visual, node-graph authoring environment for
building custom geospatial tools and web-app widgets, with no code
required for common cases.

This delivers the kind of visual geoprocessing workflow analysts expect from
a modern GIS platform, plus the extra ability to publish the same graph as a
draggable widget in the app builder.

## Why a visual builder

- Analysts think in pipelines ("take this layer, buffer it by 100m, intersect
  with that layer, style by attribute X"). A node graph matches that mental
  model better than code for non-developers.
- The same graph can power a background tool, a real-time widget, or a
  scheduled job, so users learn one mental model.
- Graphs are serializable JSON, easy to version, diff, review, share.

## Stack choice

- **React Flow** for the canvas: mature, extensible, active. The ecosystem
  leader; used by n8n, Typebot, Langflow.
- A typed node catalog defined in TypeScript; nodes self-describe their
  inputs, outputs, and config schema (using `packages/form-schema` for the
  config UI).
- Runtime executor written in Node, with PostGIS pushdown.

## Node taxonomy

| category | examples |
| --- | --- |
| Source | DataLayer, FormSubmissions, UploadedFile, HTTPFetch, Constant |
| Spatial | Buffer, Intersect, Union, Dissolve, Clip, Reproject, Simplify |
| Attribute | Filter, JoinByAttr, JoinBySpatial, Aggregate, Calculate |
| Enrichment | Geocode, ElevationLookup, Weather (via plugin) |
| Output | DataLayerSink, Chart, MapLayer, FileExport, ReportPanel |
| Compute | SQL, JavaScript |
| Control | Switch, Loop, Try/Catch (later phases) |

Nodes are pluggable. A plugin declares its nodes in a manifest; plugins can
be installed per-org.

## Graph JSON (rough shape)

```jsonc
{
  "version": 1,
  "inputs": [
    { "id": "parcels", "type": "data-layer", "label": "Parcels" },
    { "id": "floodplain", "type": "data-layer", "label": "Floodplain" }
  ],
  "nodes": [
    {
      "id": "n1",
      "kind": "Buffer",
      "config": { "distanceMeters": 100 },
      "inputs": { "layer": { "from": "parcels" } }
    },
    {
      "id": "n2",
      "kind": "Intersect",
      "inputs": {
        "a": { "from": "n1", "output": "result" },
        "b": { "from": "floodplain" }
      }
    }
  ],
  "outputs": [
    { "id": "risky_parcels", "from": "n2", "output": "result" }
  ]
}
```

## Execution model

Two runners, chosen per node:

1. **SQL pushdown (default)**: most spatial ops have PostGIS equivalents:
   `ST_Buffer`, `ST_Intersection`, `ST_Union`, `ST_DWithin`, etc. We compile
   the graph to a single PostGIS query where possible; this is dramatically
   faster than shipping data around.
2. **Node worker**: for ops without a SQL equivalent, or for lightweight
   client-side previews, turf.js runs in-process.

Jobs are persisted: each execution produces a `tool-run` record with
status, logs, and outputs (ephemeral by default; can be promoted to a
permanent feature-service item).

## Widget export

A tool can be published as a widget. The widget manifest declares:

- Which graph inputs are user-facing (e.g. a layer picker, a number input)
- Which outputs render as UI (map layer, chart, list)
- A React Flow → runtime binding that lives in `apps/app-builder`

This means every tool is dual-use: run-as-analysis or drag-and-drop widget.

## UX notes

Beyond what traditional geoprocessing model builders offer:

- Live preview (run the graph on a 1% sample as you edit)
- Inline docs per node
- Natural-language search ("something to buffer a layer")
- Versioning (every save is a new revision; diff between revisions)
- Templates (pick from a gallery to start)

## Prior art worth lifting

A few open source GIS tools have ideas to crib when the tool surface
fills out.

**SAGA GIS** (ships alongside QGIS in the standard OSGeo4W install).

- Tool library taxonomy. SAGA groups hundreds of geoprocessing tools
  into domain libraries: Terrain Analysis, Imagery, Grid, Shapes,
  Spatial and Geostatistics, Climate & Weather, Simulation,
  Projection, Import/Export, Visualization. Users find things by
  domain rather than navigating Esri-style verb buckets ("Analysis /
  Conversion / Data Management") that tell them nothing. Once our
  node catalog grows past the initial 20 to 30 nodes, reorganize
  categories by domain rather than verb.
- Tool Chains. SAGA has a first class XML format for composing
  tools into pipelines with typed inputs, typed outputs, and
  parameter wiring. It is text, version-controllable, and replayable
  headless via saga_cmd. Our graph JSON serves the same role; SAGA's
  schema is worth studying when we extend ours with control flow or
  reusable sub-graphs.
- QGIS Processing provider. SAGA exposes itself as a Processing
  provider inside QGIS, so every SAGA tool appears in the Processing
  toolbox callable on QGIS layers. The companion gratis-gis-qgis
  plugin should ship a Processing provider that does the same for
  portal-hosted tools. That is a Phase 3+ item on the plugin side,
  but worth keeping in view: any tool we publish in the portal
  becomes runnable inside QGIS for free.
- Terrain analysis depth. SAGA's hydrology, geomorphometry, channel
  network, and visibility algorithms are best in class in open
  source. Rather than reimplement them natively in the node runner,
  wrap them. A `saga_cmd` node kind that shells out to the installed
  SAGA binary is a viable third runner alongside SQL pushdown and
  the Node worker. The same wrapping approach applies to
  whitebox-tools, the GDAL CLI, and PDAL.

Not worth borrowing from SAGA: the desktop-first UX patterns, the
dense panel layout, the cryptic library name "Garden", or the C++
implementation. GratisGIS stays portal-resident and TypeScript /
Python.

## Scope & phasing

Phase 7 delivers:

- Canvas + node catalog (baseline 20–30 nodes)
- SQL-pushdown runner for common spatial ops
- Save/run/view-results flow
- Widget export MVP (map-layer + chart outputs)

Post-phase-7:

- Scheduled tools
- Control-flow nodes (loop, conditional)
- Plugin marketplace
