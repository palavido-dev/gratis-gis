# Legend customization - design doc

## Why this exists

The legend today is a stateless presentational component. It reads
each visible layer's renderer config and renders hardcoded
templates: layer title as header, raw field values as class labels
("moderate", "high"), numeric breaks as auto-generated range
strings ("< 10", "10 to < 50", ">= 50"). Group layers are filtered
out entirely.

Authors have asked for three concrete affordances:

1. **Custom labels for symbols.** A unique-values renderer keyed
   on a column whose raw values are "1", "2", "3" should be
   render-time relabelable to "Light damage", "Moderate damage",
   "Severe damage" without changing the underlying data.
2. **Hide the layer-name header.** When the author has labeled the
   symbols clearly, the layer title becomes redundant noise. They
   want the option to render just the symbol list.
3. **Include group-layer titles as section headers.** The opposite
   direction: when several leaf layers belong to a thematic group,
   show the group's title above its leaves so the legend reads as
   a structured outline.

This doc proposes a contained "decent set of options" - no
ArcGIS-Pro-style patch-width / arrangement / indent matrix. The
goal is one Legend section in the per-layer Properties surface
plus a small map-level toggle, and a per-class label override
mechanism that's obvious to authors who don't know any other
legend tool.

## Current state

`apps/portal-web/src/app/items/[id]/map/legend.tsx`:

- Reads `layers` and `metadata` (from MapCanvas), filters to
  `visible && !group && !table`, walks each layer's
  `renderer.kind`, renders one block per layer.
- For unique-values: header `by {field}` + per-category swatch +
  raw `category.value` text + a hardcoded `other` row.
- For class-breaks: header `{field}` + auto-generated range labels
  computed from the `stops` array.
- For simple: geometry family label only.

No per-layer legend config, no per-class label overrides, no
group-section rendering, no map-level legend persistence.

## Schema additions

Two layers of config: per-layer (most settings) and map-level (a
single global toggle for layer-name visibility).

### `MapLayer.legend`

```ts
interface MapLayerLegend {
  /** When false, this layer is omitted from the legend entirely.
   *  Default true. Useful for context layers (basemap-style
   *  reference data) that don't need explanation. */
  enabled?: boolean;

  /** Override the layer's display name in the legend. Default:
   *  use `layer.title`. Empty string clears (falls back to title);
   *  null hides the layer-name header for this layer specifically.
   *  Map-level showLayerNames takes precedence: if that's false,
   *  the override is moot for that map. */
  titleOverride?: string | null;

  /** Per-class label overrides for unique-values renderers. Keyed
   *  by the raw value the renderer matched on. Missing entries
   *  fall back to the raw value (current behaviour). Empty string
   *  is treated as "use raw value" -- to truly hide the label,
   *  drop the entry instead. */
  classLabels?: Record<string, string>;

  /** Per-break label overrides for class-breaks renderers. Keyed
   *  by the break index (0-based against the `stops` array, with
   *  index 0 = "below the first stop"). Same fallback semantics
   *  as classLabels. */
  breakLabels?: Record<string, string>;

  /** Override for the "other" / unmapped-values bucket on a
   *  unique-values renderer. Default copy is "other". */
  otherLabel?: string;
}
```

### `MapData.legend`

```ts
interface MapLegend {
  /** Map-level: hide every layer-name header in the legend.
   *  Authors who labeled their symbols clearly use this to get a
   *  flat, dense legend. Default false (preserves today's
   *  behaviour). */
  hideLayerNames?: boolean;

  /** Show group-layer titles as section headers above their
   *  child layers. Default true going forward (groups exist for a
   *  reason; surfacing them by default reads better in most
   *  forms), but the toggle lets authors flip back to the flat
   *  list if a group is more about layer-panel organisation
   *  than legend structure. */
  showGroupHeaders?: boolean;

  /** Persist whether the legend is open by default when the map
   *  loads. Today this is local React state and resets every
   *  time the page renders. Default false (closed). */
  defaultOpen?: boolean;
}
```

## UI surface

### Per-layer Legend section

Inside the layer Properties accordion (next to Style, Renderer,
Popup, Labels, etc.), a new "Legend" section. Layout:

```
[ Legend ]
  [x] Show in legend
      Title in legend  [_______________]   (default: layer title)
  
  Class labels                              (visible when renderer is
    Raw value 1   →  [_________________]    unique-values; one row per
    Raw value 2   →  [_________________]    declared category)
    "Other"       →  [_________________]
  
  Break labels                              (visible when renderer is
    Below first   →  [_________________]    class-breaks; one row per
    First to next →  [_________________]    break + the below/above
    ...                                     buckets)
    Above last    →  [_________________]
```

For a "simple" renderer there are no class rows; just the Show /
Title pair.

### Map-level Legend section

In the map's top-right toolbar drawer (where Legend / Attributes
/ Layer access already live), a small Legend Settings affordance
(gear icon next to the Legend button) opens a popover:

```
[ Legend settings ]
  [ ] Hide layer names
      Reads as a flat list of symbols. Use when each symbol is
      already labeled clearly enough to stand alone.

  [x] Show group headers
      When layers are organized into groups, show the group's
      name as a section header in the legend.

  [ ] Open by default
      Show the legend when the map first loads.
```

These are small toggles, low-traffic configuration; not worth a
full accordion.

## Render rules (precedence)

When the legend renders a class label, walk this order:

1. If `layer.legend.classLabels?.[value]` exists and is non-empty,
   use it.
2. Otherwise, the raw value (current behaviour).

Same logic for `breakLabels` keyed by break index, and for
`otherLabel`.

When rendering the layer-name header:

1. If `mapData.legend.hideLayerNames === true`, omit entirely.
2. Else if `layer.legend.titleOverride === null`, omit for this
   layer.
3. Else if `layer.legend.titleOverride` is a non-empty string, use
   it.
4. Else use `layer.title`.

When rendering group headers:

1. If `mapData.legend.showGroupHeaders === false`, flatten (today's
   behaviour).
2. Else, walk `mapData.layers` in order; whenever a layer's
   `groupId` differs from the previous one, emit a group-name
   row with the group layer's title before continuing the list.

Group layers themselves remain hidden from the legend (they don't
have their own renderer), but their titles appear as section
headings.

## Migration

All schema additions are optional. Existing maps render exactly
the same: missing `MapLayer.legend` => current per-layer
behaviour; missing `MapData.legend` => current map-level
behaviour. Authors who want the new affordances opt in via the
new UI sections; nothing rewrites their persisted maps without
their action.

## What this deliberately doesn't do

Per the user's "decent set of options, not ArcGIS-Pro-complicated"
brief, out of scope:

- Patch sizing (width / height of the swatch).
- Arrangement choice (Patch | Label | Description vs other
  orderings).
- Per-row indent control.
- Feature-extent filtering on legend ("only show classes visible
  in current viewport").
- Feature counts per class.
- Drag-reorder of legend entries independent of layer order.
- Per-layer legend description / footnote text.

If any of those become real requests later, they slot into the
same `MapLayerLegend` / `MapLegend` config without breaking the
v1 surface.

## Phasing

- **Phase 1 - schema**: Add `MapLayerLegend` + `MapLegend`
  interfaces to shared-types. No UI yet, no render changes.
  Sub-shippable; missing config blocks fall through to current
  behaviour.
- **Phase 2 - render**: Update `legend.tsx` to consume the new
  config. Class-label / break-label / titleOverride / hideLayerNames /
  showGroupHeaders all become real. Authors can hand-edit the
  item JSON to test before the UI lands.
- **Phase 3 - per-layer UI**: New "Legend" section in the layer
  Properties surface. Show/hide toggle, title override, per-class
  label rows.
- **Phase 4 - map-level UI**: Gear icon next to the Legend
  toolbar button opens a small settings popover with the three
  map-level toggles. Persists to `MapData.legend`.

Phases 1 + 2 unlock everything for power users; phases 3 + 4
make it accessible to non-power users.

## Open questions

1. Should the per-class label editor pre-populate from the
   layer's metadata (the actual values the renderer mapped) or
   leave the rows empty until the author types? Pre-populating is
   nicer but requires resolving distinct values, which today's
   editor doesn't do for unique-values renderers (the renderer
   takes a hand-curated category list anyway, so the values are
   already declared).
2. Group headers when a group has only one child layer - emit
   the header anyway, or collapse? Tentatively: collapse, because
   a single-leaf group is structurally redundant.
3. Should `hideLayerNames` be per-layer (the current `titleOverride: null`
   already covers that) instead of map-level? Decision: keep
   both. Per-layer is for "this one specific layer doesn't need
   a header"; map-level is for "this whole map's symbols are
   self-describing".

## Status

Pre-implementation. Awaits Matt's read-back to confirm the
schema shape and the UI grouping (one accordion section per
layer + one toolbar popover) before any code lands.
