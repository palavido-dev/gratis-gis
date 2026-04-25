# Web maps

A map is an item whose `dataJson` describes a MapLibre camera, a
basemap choice, and (eventually) an ordered stack of overlay layers.
It is the first full pillar: create a map, choose a basemap, pan to
the area you care about, save, share.

## Data shape

See `packages/shared-types/src/web-map.ts`. The shape is intentionally
minimal in v1 and extends additively:

```ts
{
  basemap: 'osm' | 'positron' | 'dark-matter' | 'voyager' | 'satellite',
  center: [lng, lat],
  zoom: number,
  bearing: number,
  pitch: number,
  layers: [] // v2: overlay layer descriptors
}
```

Tolerate missing fields on read. `DEFAULT_MAP` provides a fallback
so old items keep rendering after additive changes.

## Basemaps

v1 uses raster tilesets that don't require an API key: OSM,
Carto Positron / Voyager / Dark Matter, and Esri World Imagery for
satellite. They're defined in `apps/portal-web/src/lib/basemaps.ts`
as MapLibre style JSON.

When we need vector basemaps or better performance, swap the style
object in that catalog without touching the viewer code.

## Viewer

`apps/portal-web/src/app/items/[id]/web-map/map-editor.tsx` is both
viewer and editor. It reads camera state from the item, renders a
MapLibre canvas, and when `canEdit` is true shows a Save bar that
PATCHes the item with the current camera + basemap.

Design principles:

- **One component, two modes.** The canEdit prop toggles the save bar;
  the rendered map is identical for viewers and editors so mental models
  stay aligned.
- **No style churn on save.** The save path serializes only camera +
  basemap; layers are passed through as-is. Re-saving without changes
  is a no-op on the backend (PATCH merges only present keys).
- **Dirty tracking from user interaction.** Programmatic setStyle
  shouldn't flip the Save button on; the viewer is bootstrapping, not
  the user reshaping the map.

## Overlay layers (v2)

A MapData carries an ordered `layers` array. Each layer declares its
source, style, popup behavior, and interaction toggles. The top of the
list draws on top (same mental model as every design tool).

Per-layer controls available today:

- **Source**: GeoJSON URL or inline GeoJSON (small datasets only;
  inline features live in the item's dataJson). Feature-service as a
  source is stubbed; it lights up when that pillar ships.
- **Visibility + opacity**: toggle and 0-100% slider.
- **Simple-renderer style**: per geometry family (point / line /
  polygon), with color, width/radius, outline color, outline width,
  and fill opacity. A GeoJSON source that mixes geometries renders
  all three styles at once, each filtered to its matching geometry.
- **Click popup**: on/off. v2 shows every feature property by
  default; field selection + templating ship next.
- **Hover highlight**: brightens the fill, thickens the outline, and
  bumps circle radius under the cursor. Cursor also switches to a
  pointer whenever the mouse is over a feature.

## Roadmap

Near term (popups + filters):

- Popup field picker and template editor.
- Hover tooltip (not just highlight) with configurable field.
- Attribute filter builder (WHERE-style clauses, applied as MapLibre
  filter expressions).
- Drag-to-reorder layers (arrow buttons in the panel today).

Medium term:

- Unique-value / class-breaks renderers for categorical + quantile
  styling.
- Drawings and measurement tools (scratch layer, save as a layer).
- Feature-service-backed layers once the pillar exists. Editing mode
  wires up once the source supports writes.
- Print composer that renders a static map into a report template.

Long term:

- Vector-tile basemaps (self-hosted planetiler or tilemaker output).
- Time-aware layers for temporal datasets.
- Offline layer packages shared with the field app.
