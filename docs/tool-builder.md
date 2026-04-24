# Tool & Widget Builder

A visual, node-graph authoring environment for building custom geospatial
tools and web-app widgets, with no code required for common cases and a Python
escape hatch via notebooks when needed.

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
| Compute | SQL, JavaScript, **NotebookStep** (delegates to a Python kernel) |
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
3. **Notebook kernel**: `NotebookStep` nodes hand a dataset to a Python
   notebook kernel (via the `notebook-hub`), receive a result back. This
   keeps the "big red button" escape hatch for anything PostGIS can't do.

Jobs are persisted: each execution produces a `tool-run` record with
status, logs, and outputs (ephemeral by default; can be promoted to a
permanent feature-service item).

## Widget export

A tool can be published as a widget. The widget manifest declares:

- Which graph inputs are user-facing (e.g. a layer picker, a number input)
- Which outputs render as UI (map layer, chart, list)
- A React Flow â†’ runtime binding that lives in `apps/app-builder`

This means every tool is dual-use: run-as-analysis or drag-and-drop widget.

## UX notes

Beyond what traditional geoprocessing model builders offer:

- Live preview (run the graph on a 1% sample as you edit)
- Inline docs per node
- Natural-language search ("something to buffer a layer")
- Versioning (every save is a new revision; diff between revisions)
- Templates (pick from a gallery to start)

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
