# Data sources: scope belongs to the layer, not the widget

Direction set by Matt, 2026-08-20, after three separate symptoms
turned out to be the same defect:

- Extent filtering did nothing on the demo dashboards, because
  following the map is declared per widget and I forgot it on all
  eight tiles.
- A chart's layer picker offered one option and named it
  `#0 4d029569 / bridges`, and the only place to add another was the
  Map widget's inspector.
- A dashboard built on a saved map cannot chart that map's layers at
  all, because the map's layers and the app's targets are two
  disconnected pools.

Matt's framing: a dashboard has to be internally consistent. If a
parent layer is filtered, its related table is filtered. A widget on a
non-spatial table should still be scopeable through a spatial parent
by a shared key. And we should not show data that is incomplete in a
map view.

The instruction on how to build it: take the better-shaped answer even
when it is more work.

## What is wrong with the current shape

`CustomAppData.targets` is `Array<{dataLayerId, layerKey}>` and
nothing else. It is an identity list. Every question about *what a
widget is actually answering* is re-declared on the widget:

- `followMapWidgetId` on chart and indicator (and absent entirely on
  attribute-table, which is why a table beside a filtered chart
  disagrees with it).
- The cross-filter selection, keyed by `targetIndex` in a page-level
  React context.
- The relate, which does not exist yet and under the current shape
  would have to be declared on every widget that needs it.

Four consequences:

1. **Inconsistency is the default.** Making a page agree costs one
   deliberate act per widget, and the cost scales with exactly the
   thing that makes a dashboard good (more tiles).
2. **`targetIndex` is positional.** Reordering or removing a target
   silently rebinds every widget on the page to a different layer.
   No error, no warning, wrong numbers. This is a live bug today.
3. **Two pools.** An app's `targets` and a referenced map item's
   layers never meet.
4. **Scope has no home.** There is nowhere to hang "this source is
   always filtered to open permits" or "this table follows its
   parent", so each feature bolts another field onto every widget.

## The shape

Promote targets into first-class data sources that carry their own
scope. Widgets reference one by stable id and declare nothing about
what it means.

```ts
export interface AppDataSource {
  /** Stable id. Widgets reference this, never a position. */
  id: string;
  /** Author-facing name. Defaults to the layer's own title. */
  label?: string;
  /** What it reads. */
  layer: { dataLayerId: string; layerKey: string };
  /**
   * Spatial scope: recompute from this map widget's current view.
   * Empty string pins the source to the whole layer.
   */
  followMapWidgetId?: string;
  /** Author-fixed predicate. Always applied, never cleared by a
   *  reader's interaction. */
  where?: MapLayerFilter;
  /**
   * Relate. Scope this source to the rows whose `myField` appears
   * among `parent`'s in-scope rows' `parentField`.
   *
   * This is what lets a table with no geometry follow a map: a well
   * is spatial, an inspection record is not, and `via` says the
   * inspections in view are the ones whose well_id belongs to a well
   * in view. The parent's OWN scope (its extent, its where, its own
   * via) is what propagates, so filtering a parent filters its
   * children with no further declaration.
   */
  via?: { sourceId: string; parentField: string; myField: string };
}
```

Widgets swap `targetIndex: number` for `sourceId: string`.

Scope resolution becomes one function, and that is the whole point:

```ts
resolveSourceScope(sourceId, {
  sources, mapViewports, crossFilterSelection,
}): { bbox?: BBox; where?: MapLayerFilter; via?: ResolvedVia };
```

Every widget calls it. There is exactly one place that decides what a
number on the page means, so two widgets on one source cannot disagree
by construction rather than by the author's diligence.

### What this buys, restated as the three symptoms

- Extent filtering is set once per source, not once per widget.
- The picker lists sources by name; adding one is a source-level act,
  not something buried in the Map widget.
- A referenced map's data layers become sources automatically, so
  they are chartable the moment the map is bound.

### Cross-filter and relate compose for free

A chart click publishes a predicate onto a **source**. Every widget on
that source re-answers, and every source whose `via.sourceId` points
at it re-answers too, because `via` inherits the parent's resolved
scope rather than a snapshot of it. That is Matt's "if the parent is
filtered the related table is filtered", with no extra mechanism.

## Server side: `via` is a semi-join, not a harvested list

The obvious implementation is to fetch the parent's key values in
view and send them as `IN (...)`. It does not survive this data.
`?where=` caps at 20 clauses, `entityIds` at 1000 UUIDs, and the
aggregate `groupBy` that would harvest the keys caps at 1000 groups
and returns *top-N by count* with a `truncated` flag. Over 23,915
parcels the key set is silently short and the answer is quietly wrong,
which is the failure mode this endpoint exists to prevent.

Both layers are rows in the same `observation` table keyed by
`scope`, so the predicate pushes down:

```sql
AND attrs->>'well_id' IN (
  SELECT p.attrs->>'well_id'
  FROM ( <parent scope, collapsed to latest per entity> ) p
  WHERE p.kind <> 'delete'
    AND <parent's own content filters: bbox, where, geo limit>
)
```

Exact, uncapped, one query. Build the parent subquery through
`dataLayerSourceSqlFragment`, which already exists as the seam for
"a data-layer source with predicates applied" and already gets the
candidate-then-collapse-then-filter ordering right.

**The parent's spatial predicate must be applied after the parent's
collapse.** Applying it before resurrects ghosts in the parent, and a
ghost parent drags real children into scope. Same rule as everywhere
else in the engine, one level up.

### Authorization is the part that must not be got wrong

`via` reads a layer the widget does not name. Without a check it is a
side channel: point a widget at a layer you can read, relate it
through one you cannot, and the counts tell you about the parent.

So a request carrying `via` must:

- resolve `canRead` on the **parent** layer, not only the child, and
  404 the way every other read does when it fails;
- apply the parent's own geo limit and row scope inside the subquery,
  because an aggregate is a read and leaks exactly as much as a read;
- refuse a `via` whose parent is in another org.

Depth is capped at 2 hops and cycles are refused by name, so a
pathological chain cannot be built by hand-editing the item JSON.

## The unlocated-rows question

NOAA gives a point for 177 of the 625 storm events; the rest are
attributed to the county or a forecast zone. A bbox filter drops rows
with no geometry, so scoping that dashboard to the map turns "625
recorded events" into "177" while still zoomed out.

The engine is already inconsistent with itself here: a share's geo
limit spares null geometry (`geom IS NULL OR ST_Intersects(...)`)
while a viewport filter uses a bare `geom && envelope` and drops it.

Under Matt's principle, a record with no location is not in any view,
so a view-scoped widget excludes it and **says so**: a source whose
scope is spatial reports how many of its rows can participate. Silence
is what makes 177 look like a bug.

The storm layer is also the case that argues for `via`: those 448
events do have a geography, just a coarser one. Modelled properly they
relate to a county or zone polygon by name and participate honestly
instead of being dropped. That is a demo-data improvement, not a code
change, and it is the better answer for that dashboard.

## Migration

`migrateCustomAppData` is a version ladder run on every load, in both
the designer and the runtime. A v4 to v5 step fits the established
pattern and needs no bulk database write: apps normalize on read and
persist on next save.

The step is mechanical:

- `targets[i]` becomes a source with a generated stable id.
- `widget.targetIndex` becomes `widget.sourceId` by position, which
  is correct precisely once: at migration time, before any reorder.
- The app-level `followMapWidgetId` added in v0.9.46 is copied onto
  every source and the app-level field is dropped. It was the right
  thing to unblock the demo and it is the wrong shape to keep; two
  mechanisms for one question is how the per-widget mess started.

`targetIndex` stays readable for one release so an app saved by an
older client still loads, then goes.

## Sizing and order

1. Schema, migration, and `resolveSourceScope`, with the runtime
   reading sources instead of indices. No new capability, no
   behaviour change the reader can see. This is the risky commit and
   it should land alone.
2. Designer: a Sources panel (add, name, remove, set extent scope and
   a fixed filter), and every widget's picker reduced to one dropdown
   of source names.
3. `via` end to end: schema, the semi-join, the authorization checks,
   pg specs including the ghost-parent case and the cross-layer
   permission case, and the designer UI.
4. Map-referenced layers become sources automatically.
5. Attribute table onto the same scope path, which closes the
   long-standing disagreement between a table and the charts beside
   it.

## Open questions

- Should a source's `where` be author-only, or should a reader-facing
  filter widget write to it too? Author-only is the safer start: a
  reader's interaction living in the same field as the author's
  intent makes "why is this number wrong" unanswerable.
- Does a source need its own `at` (bitemporal) override, or does app
  time stay global? Global until someone asks.
