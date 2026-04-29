# Derived layers

A `derived_layer` is an Item whose contents are computed at read time from
another layer plus an ordered pipeline of tool steps. The derived layer
stores the recipe, not the result. When the source layer's features change,
the derived layer reflects those changes on the next read.

This document covers v1 scope. Out-of-scope ideas are flagged in
[Out of scope (v1)](#out-of-scope-v1).

## Status

Phase: design (this doc). Implementation has not started.

v1 ships:

- One new item type: `derived_layer`.
- One tool: `buffer`.
- Source: a single `data_layer` item. No chaining of derived layers.
- Read path: reuses `GET /api/items/:id/geojson?bbox=&at=&clip=`.
- Storage: pure on-the-fly compute. No materialization, no caching beyond
  what the existing read path already does.

This makes the derived-layer item a precursor to the Phase 7 tool builder
(see [ROADMAP.md](../ROADMAP.md)). The tool registry shape introduced here
is designed so a tool-builder node can later wrap the same generators
without forking code.

## Why not store SQL?

A derived layer's storage is **structured parameters**, never a raw SQL
string. Three reasons:

1. **Security.** A row that contains executable SQL is a SQL injection /
   data exfiltration vector for anyone who can write to the row.
2. **CONTRIBUTING rule 7** (guided before raw input). A SQL textarea is
   the textbook "advanced fallback" surface, not the primary entry.
3. **Editability.** A typed pipeline can be rendered as a wizard, diffed
   in PRs, validated, and migrated forward as tool definitions evolve.
   A SQL string can't.

The API holds a small library of tool generators. Each generator takes
`(source, params)` and emits a parameterized SQL fragment. Users never
see SQL.

## Data shape

A `derived_layer` item reuses the existing polymorphic `Item` row. No
new tables. The `data` JSON blob holds the recipe:

```ts
// packages/shared-types/src/derived-layer.ts
export interface DerivedLayerData {
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1;

  /** The single input layer. v1 = data_layer only. */
  source: {
    kind: 'data_layer';
    itemId: string;
  };

  /**
   * Ordered list of tool steps. The output of step N is the input of
   * step N+1. v1 ships only `buffer`; the union grows as tools are
   * added. Empty pipeline is invalid (use the source layer directly).
   */
  pipeline: ToolStep[];

  /**
   * Cap on features returned by the read path. Hard ceiling, applied
   * after the pipeline runs. Default 1000. The map UI passes a bbox
   * on every read (see "Extent and feature cap" below), so on real
   * map workflows this cap rarely bites; it's the safety net for
   * "open the layer with no map context" cases.
   */
  featureLimit: number; // default 1000

  /**
   * Cached output schema (column list with types). Computed at save
   * time from the source schema + pipeline. Lets dashboards and apps
   * bind to the layer without running the query.
   */
  outputSchema: FeatureField[];
}

export type ToolStep =
  | BufferStep
  // future: DissolveStep | IntersectStep | ...
  ;

export interface BufferStep {
  tool: 'buffer';
  params: {
    /** Buffer distance in `unit`. Must be positive. */
    distance: number;
    /** v1: 'meters' only. Other units arrive when reprojection lands. */
    unit: 'meters';
  };
}
```

`Item.bbox` is recomputed on save as the source bbox expanded by the
pipeline's outward reach (for buffer: source bbox + buffer distance,
converted to degrees at the source's latitude).

## Tool registry and generator interface

Each tool is a small module that knows its parameter shape, how to
validate it, how its output schema relates to the input schema, and
how to emit a SQL CTE that produces its output rows.

```ts
// apps/portal-api/src/derived-layers/tools/types.ts
export interface ToolGenerator<TParams> {
  /** Stable identifier; matches the discriminator in `ToolStep`. */
  kind: string;

  /** Runtime validation (zod). */
  paramsSchema: ZodType<TParams>;

  /**
   * Compute the output schema from the input schema + params. Pure.
   * Called at save time to populate `outputSchema`.
   */
  outputSchema(input: FeatureField[], params: TParams): FeatureField[];

  /**
   * Compute how far this tool can grow geometries outward, in meters.
   * Used to expand the read bbox so features near the edge keep their
   * halo. Most tools return 0; buffer returns its distance. A pipeline's
   * total reach is the sum of its steps.
   */
  outwardReachMeters(params: TParams): number;

  /**
   * Emit a SQL fragment that produces the tool's output as a CTE-style
   * subquery over `inputAlias`. Returns `{ sql, params }` where `params`
   * are appended to the outer query's parameter list. The fragment must:
   *   - select `geom` (PostGIS geometry, SRID 4326), `global_id`, and
   *     all attribute columns from the schema it declared in
   *     `outputSchema`.
   *   - reference `inputAlias` for input rows.
   *   - never inline user input as text; everything goes through
   *     parameter placeholders.
   */
  toSql(inputAlias: string, params: TParams, paramOffset: number): {
    sql: string;
    params: unknown[];
  };

  /**
   * Item references the tool's params hold (other layers, pick lists,
   * etc.). Returned to the dependency extractor so the derived layer's
   * forward edges are complete. v1 buffer returns empty arrays.
   */
  extractDependencies(params: TParams): {
    itemIds: string[];
    urls: string[];
  };
}
```

The registry is a `Map<string, ToolGenerator<unknown>>`. Adding a new
tool is a new file plus a registry entry, no schema migration.

## Read path

`GET /api/items/:id/geojson` already routes by item type. We extend it:
when `item.type === 'derived_layer'`, the service builds a chained CTE
over the source's PostGIS table.

Pseudocode for the v1 buffer case:

```sql
WITH source AS (
  SELECT global_id, geom, /* ...attrs... */
  FROM fs_<source_uuid>
  WHERE valid_to IS NULL                              -- temporal
    AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4, 4326))  -- expanded bbox
  /* boundary clip applied here if ?clip= present */
),
step_1 AS (                                           -- buffer
  SELECT global_id,
         ST_Buffer(geom::geography, $5)::geometry AS geom,
         /* ...attrs... */
  FROM source
)
SELECT * FROM step_1
LIMIT $6;                                             -- featureLimit
```

Notes:

- Source filtering happens **before** the pipeline, on an **expanded**
  bbox. The expansion is `pipeline.outwardReachMeters()` converted to
  degrees at the bbox latitude. This preserves halo correctness at
  tile edges.
- The boundary clip (`?clip=`) is applied to the source, mirroring the
  data-layer behavior, with the same expansion.
- `featureLimit` is applied at the end. If the user passed `?bbox=`,
  the result is "features inside the (post-pipeline) bbox view, capped
  at featureLimit". If they didn't, it's the global cap.
- Buffer uses `geography` so the distance is in meters regardless of
  longitude. Distances stay correct globally.

## Extent and feature cap

Two cooperating defaults:

- **Bbox + halo.** When the map viewer requests features for the
  current frame, it sends `?bbox=`. The API expands that bbox by the
  pipeline's outward reach before querying the source, then clips back
  to the user's bbox after the pipeline runs (or relies on MapLibre to
  draw outside the view, depending on tile boundary).
- **Feature cap.** A hard ceiling. Default 1000. Settable per layer
  in the wizard. Applied as `LIMIT N` after the pipeline.

Per Chris's call: take whichever returns fewer rows. In practice the
bbox prefilter usually wins for map workflows; the cap is the safety
net for "no map context" reads (e.g., a dashboard panel that opens
the layer without a view extent).

## Sharing

A derived layer has its own `ItemShare` rows like any other item. The
read check is the **intersection** of the derived layer's ACL and the
source layer's ACL: a user can read the derived layer iff they can
read both.

Implemented as a delegated check inside `sharing.service.ts` (the
"bedrock", per CONTRIBUTING). When `getGeoJson` resolves a derived
layer, it calls the existing sharing check on the source as the
calling user before running the SQL. If the source check fails, the
read fails closed regardless of who shared the derived layer.

This propagates revocation for free: when the source is unshared, the
derived layer stops returning rows on the next read with no background
job.

## v1 buffer tool

Specification:

- **kind**: `'buffer'`
- **params**: `{ distance: number, unit: 'meters' }`. `distance > 0`.
- **outputSchema**: identical to input schema. Buffer keeps every
  attribute; only geometry changes.
- **outwardReachMeters**: `params.distance`.
- **toSql**: wraps `ST_Buffer(geom::geography, $distance)::geometry`.
  The cast to `geography` makes the distance unambiguous in meters
  worldwide.

Validation rules:

- `distance` must be finite and `> 0`. UI bounds it to a sensible max
  (e.g., 100 km) to prevent accidental world-spanning buffers.
- Source layer must have a non-null geometry column. Empty layers
  produce empty results.

UI surface (per rule 7, guided primary):

- Wizard step 1: pick the source data layer (same picker the map
  builder uses).
- Wizard step 2: enter buffer distance with a unit dropdown. Live
  preview on the map of one feature buffered at the chosen distance.
- Wizard step 3: name + tags + sharing. Same as any item-create flow.

No raw SQL surface, no JSON paste field. If a power-user surface ships
later, it's a separate item type.

## Output schema and bbox

Computed once at save time and stored on `data.outputSchema`. For
buffer it's a copy of the source's field list; for tools that change
attributes (dissolve, count-in-polygon, etc.) the generator returns
the new shape. Dashboards and apps bind to `outputSchema` so they
never need to "open the layer to see what columns it has".

`Item.bbox` is the source's bbox padded outward by
`pipeline.outwardReachMeters()`. Recomputed when the source bbox
changes (the existing data-layer save path already touches this; we
hook a re-derive there).

## Dependency graph

Every item in GratisGIS publishes its forward edges (what it depends on)
and exposes its reverse edges (what depends on it) through a single
machinery: `extractDependencies()` in
`apps/portal-api/src/items/dependency-extractor.ts` plus
`GET /items/:id/dependencies` and
`GET /items/:id/dependents?transitive=true|false`. A derived layer
participates in that paradigm like any other item: its source and any
item-typed tool parameters are first-class edges, never opaque blobs.

### Forward edges (what a derived layer depends on)

The extractor gains a `derived_layer` branch that walks `data` and
emits:

- `data.source.itemId` for every derived layer. Always present, always
  a hard dependency: deleting the source breaks the derived layer's
  ability to return rows.
- For each step in `data.pipeline`, any item references the tool
  declares. v1 buffer has none. To keep the extractor stable as tools
  arrive, each `ToolGenerator` declares a small helper:

```ts
// On the ToolGenerator interface
extractDependencies(params: TParams): { itemIds: string[]; urls: string[] };
```

The extractor calls it for each step and merges the results. A future
`intersect` tool whose params include a second-layer item ID returns
that ID here; a future tool that pulls choices from a `pick_list`
returns the pick list ID here. New tools become discoverable to the
dependency graph without any changes outside the tool's own file.

### Reverse edges (what depends on a derived layer)

No code change needed. The reverse index is built by the items
service from each item's forward edges, so as soon as the extractor
emits a `data_layer -> derived_layer` edge, the data layer's "Used
by" panel and `GET /items/:dataLayerId/dependents` automatically list
the derived layers built on top of it.

A derived layer is itself a valid dependency target: a map that adds
the derived layer as a layer source records the same `data-layer`
shaped reference (since to the map renderer it's still a layer of
features). The map's "Depends on" panel lists the derived layer; the
derived layer's "Used by" panel lists the map. Transitive lookups
walk the chain (`data_layer -> derived_layer -> map -> dashboard`)
through the existing `?transitive=true` path.

### Deletion and rename behavior

The existing deletion semantics apply unchanged:

- Soft-delete a source `data_layer`: any derived layer that depends
  on it returns empty results until either the source is restored or
  the derived layer is repointed / deleted. The "Used by" panel on
  the source shows the affected derived layers before confirming the
  delete, matching the current pattern for maps that reference a
  layer.
- Hard-delete (admin purge) a source: dependent derived layers are
  left with a dangling `source.itemId`. The read path treats a
  missing source as an empty FeatureCollection (same as a missing
  `geo_boundary` clip today). The dependents panel surfaces the
  dangle so an admin can clean it up.
- Rename / re-share a source: no change to the derived layer's
  recipe. The reference is by UUID, not title, and sharing is
  re-evaluated on every read (see [Sharing](#sharing)).

### What this gives users

- The "Depends on" panel on a derived layer lists its source plus any
  pick lists / second-input layers a future tool introduces.
- The "Used by" panel on a data layer lists every derived layer over
  it, alongside the maps and forms that use it directly.
- An impact report before deletion. Admins can see "this data layer
  is used by 3 maps, 2 dashboards, and 4 derived layers (which are
  themselves used by 1 dashboard)" and decide accordingly.
- A search query like "what depends on this data layer transitively"
  works without any new endpoints.

## CRS and units

v1 stores all geometries in EPSG:4326 (matching the existing
`data_layer` tables). Buffer distance is in meters via the
`geography` cast. Other CRSes and other units land when we add a
reprojection step to the pipeline (probably as its own tool,
`reproject`).

## Out of scope (v1)

- Chaining: a derived layer's source must be a data layer. Stacking
  derived layers is deferred until there's clear demand. When it
  comes, the sharing rule already generalizes (intersection over the
  full ancestor chain), and cycle detection plus a depth cap are
  needed. Track in a follow-up issue.
- Materialization: no matview, no on-disk cache. A pure view is
  correct and simple. When perf becomes a problem, add a
  `materialization: 'view' | 'cache' | 'matview'` knob and
  NOTIFY/LISTEN-driven refresh.
- More tools: dissolve, intersect, centroid, convex hull,
  point-in-polygon counts, distance to nearest. Each is one new
  generator file plus a wizard step. Land them one at a time as
  demand surfaces.
- A power-user "raw SQL" item type. Has security implications that
  warrant its own design.
- Bidirectional editing: a derived layer is read-only. Edits to its
  features go through the source.

## Open questions

- Do derived layers participate in the temporal `?at=` query? v1 says
  yes (the source CTE honors `valid_to IS NULL` or the `at` snapshot
  the same way data layers do). Confirm during implementation.
- Does the field map's "edit one feature at a time" UX need to know
  the layer is derived? Probably yes (greyed-out edit affordance with
  a tooltip explaining edits go through the source).
- Do we need a debounce on the wizard's live preview when distance
  changes rapidly? Unknown; benchmark on a 50k-feature layer.

## Files affected

- `packages/shared-types/src/derived-layer.ts` (new)
- `packages/shared-types/src/item-types.ts` (add `'derived_layer'`)
- `packages/shared-types/src/index.ts` (export new types)
- `apps/portal-api/prisma/schema.prisma` (add `derived_layer` enum value, migration)
- `apps/portal-api/src/derived-layers/` (new module: controller, service, tool registry, buffer generator)
- `apps/portal-api/src/items/items.service.ts` (route `derived_layer` reads to the new service)
- `apps/portal-api/src/items/sharing.service.ts` (intersection check)
- `apps/portal-api/src/items/dependency-extractor.ts` (new `derived_layer` branch that emits `source.itemId` plus the merged output of each tool's `extractDependencies`)
- `apps/portal-web/src/app/items/derived-layers/` (wizard UI, detail page)
- `docs/data-model.md` (mention the new item type)

## Test strategy

- Unit tests on each tool generator's `outputSchema`, `paramsSchema`,
  and `outwardReachMeters`. Pure functions, easy to cover.
- Snapshot tests on emitted SQL against a fixed param set, parameter
  offsets, and input alias.
- Integration test: create a `data_layer` with N points, create a
  `derived_layer` over it with `buffer { distance: 100m }`, read with
  `?bbox=`, assert geometry is a polygon and edge features get a halo.
- Sharing test: two users, A owns source, A shares derived with B but
  not source. B's read returns 403 (or empty, depending on the
  sharing service's idiom for "you can see the item but not the
  data").
- Dependency tests:
  - `extractDependencies` on a `derived_layer` returns
    `source.itemId` plus the merged tool refs.
  - `GET /items/:dataLayerId/dependents` on a data layer that has a
    derived layer over it lists that derived layer; with
    `?transitive=true` it also lists maps that use the derived layer.
  - Soft-deleting the source data layer leaves the derived layer's
    forward edge intact (it still resolves through the trash) so the
    "Used by" panel can show the link before the cascade.
