/**
 * Canonical shape stored in an Item's dataJson when `type = 'map'`.
 *
 * Versioned for forward compatibility: when we need a breaking change to
 * layer structure, bump the `version` field and write a migrator. The
 * viewer is expected to tolerate missing fields and fall back to
 * defaults so older maps keep rendering after additive changes.
 */
/**
 * Well-known marker stored in `data_json.seededKey` on the five built-in
 * basemap items that every org gets seeded with on creation. The union
 * stays here as a convenience for callers that want to pick a specific
 * built-in (e.g. `DEFAULT_MAP` resolves to whichever item has
 * `seededKey === 'positron'` in the viewing org). Do NOT treat these
 * as a closed set of valid basemaps; they are just the seeded
 * defaults. Users can delete or rename the seeded items, and add any
 * number of their own basemap items.
 */
export type BuiltinBasemapSeedKey =
  | 'osm'
  | 'positron'
  | 'dark-matter'
  | 'voyager'
  | 'satellite';

export const BUILTIN_BASEMAP_SEED_KEYS: BuiltinBasemapSeedKey[] = [
  'positron',
  'osm',
  'voyager',
  'dark-matter',
  'satellite',
];

/**
 * Seeded by the portal on org creation so every org has a working set
 * of built-in basemaps out of the box. Kept in one place (instead of a
 * .env or config file) so admins never have to restart the API to
 * change the basemap library. The migration
 * 20260424280000_seed_builtin_basemaps hardcodes the same list for
 * existing orgs; this array is what the auth-sync hook uses for
 * newly-created orgs.
 */
export interface BuiltinBasemapSeed {
  seededKey: BuiltinBasemapSeedKey;
  title: string;
  description: string;
  tileUrl: string;
  attribution: string;
}

export const BUILTIN_BASEMAP_SEEDS: BuiltinBasemapSeed[] = [
  {
    seededKey: 'positron',
    title: 'Positron',
    description: 'Light and muted. Good base for overlay data.',
    tileUrl: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors (c) Carto',
  },
  {
    seededKey: 'osm',
    title: 'OpenStreetMap',
    description: 'Classic OSM raster. Broad coverage, familiar styling.',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors',
  },
  {
    seededKey: 'voyager',
    title: 'Voyager',
    description: 'Balanced contrast with clear place labels.',
    tileUrl:
      'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors (c) Carto',
  },
  {
    seededKey: 'dark-matter',
    title: 'Dark matter',
    description: 'Dark theme for dashboards and presentations.',
    tileUrl: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '(c) OpenStreetMap contributors (c) Carto',
  },
  {
    seededKey: 'satellite',
    title: 'Satellite',
    description: 'ESA / ArcGIS Online World Imagery.',
    tileUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery (c) ESA WorldCover',
  },
];

export interface MapData {
  version: 1;
  /**
   * UUID of the basemap item this map renders against. Resolved at
   * render time against the org's basemap items (items with
   * type='basemap'). Empty string is a sentinel meaning "use the org
   * default"; the server fills it in on create, the viewer falls back
   * to the org's `seededKey='positron'` seed if the referenced item
   * has been deleted.
   */
  basemap: string;
  /**
   * Optional reference to a geo_boundary item. When set, the map
   * editor and viewer fit the camera to this boundary's geometry
   * on first open, falling back to `center` / `zoom` if the
   * boundary item is missing or has no geometry yet. Lets one
   * curated boundary act as the canonical extent for many maps
   * (#53 geo_boundary reuse). Mutually independent of `bbox` /
   * `center` / `zoom`: persisted camera state still gets used for
   * subsequent visits where the user has panned away from the
   * boundary's footprint.
   */
  defaultExtentBoundaryId?: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  layers: MapLayer[];
  search: MapSearchConfig;
}

/**
 * Map-level search settings. Per-layer attribute search is configured
 * on each MapLayer; this controls how address geocoding works and
 * whether the search bar shows up at all.
 */
export interface MapSearchConfig {
  /** Whether the search bar is visible on the map. Default on. */
  enabled: boolean;
  /**
   * Whether to geocode free-text queries via a third-party service
   * (Nominatim by default). Some orgs prefer keeping searches local
   * to their own data and will turn this off.
   */
  geocoding: boolean;
}

export interface MapLayer {
  id: string;
  title: string;
  visible: boolean;
  /** 0-1 multiplier applied to all paint fill / stroke / circle alpha. */
  opacity: number;
  source: MapLayerSource;
  style: MapLayerStyle;
  /**
   * How to color features: one color for everything, or one color per
   * distinct value of an attribute. `null` means use the simple style
   * colors as-is.
   */
  renderer: MapLayerRenderer;
  popup: MapLayerPopup;
  interactions: MapLayerInteractions;
  labels: MapLayerLabels;
  search: MapLayerSearch;
  /**
   * Optional single-clause attribute filter. Null means "show every
   * feature". A multi-clause boolean builder can land later; one
   * clause covers most real-world filtering needs and keeps the
   * editor small.
   */
  filter: MapLayerFilter | null;
  /**
   * Per-layer scale visibility. `null` on either bound means
   * "unconstrained"; MapLibre's min/maxzoom properties clamp to
   * 0 / 24 at the extremes. Zoom is stored rather than scale
   * denominator so the shape matches MapLibre directly: the editor
   * surfaces a human-readable scale hint next to each slider.
   */
  scale: MapLayerScale;
  /**
   * Per-layer access policy. Default `policy: 'inherit'` means the
   * underlying item's sharing decides everything. `'custom'` enables
   * the matrix: each principal the webmap is shared with gets an
   * entry with explicit view / query / edit flags. Server enforcement
   * always caps by item-level access: the matrix can subtract (hide
   * a layer from a specific principal on this map) but can never
   * grant access the underlying item didn't already allow.
   */
  access: MapLayerAccess;
  /**
   * Server-computed permissions for the current viewer. Only present
   * on responses the server filtered for a non-editor viewer: the
   * editor's view of the webmap sees full `access.entries` and no
   * `effective` field. Client honors `effective.query === false` by
   * disabling popups / attribute access for the layer.
   */
  effective?: {
    view: boolean;
    query: boolean;
    edit: boolean;
  };
}

/**
 * Per-layer access entry. Anchors to a principal (user or group) by
 * id; the layer is visible to that principal only when `view` is
 * true. `query` gates popups / attribute-table / search; `edit`
 * reserves future feature-editing once that pillar ships.
 */
export interface MapLayerAccessEntry {
  principalType: 'user' | 'group';
  principalId: string;
  view: boolean;
  query: boolean;
  edit: boolean;
}

export interface MapLayerAccess {
  /**
   * `'inherit'`: no per-layer restriction beyond item-level sharing.
   * `'custom'`: apply `entries`: a principal not listed (and not a
   * member of a listed group) defaults to the layer being hidden for
   * them. Authors flip to `'custom'` the first time they adjust the
   * matrix; until then, everyone who can see the webmap can see
   * every layer they have item access to.
   */
  policy: 'inherit' | 'custom';
  entries: MapLayerAccessEntry[];
}

/**
 * Zoom-range visibility for a whole layer plus its labels. Scale is
 * modelled as MapLibre zoom (0 = world, 22 = street). Labels carry
 * their own range because it's common to want a feature visible while
 * hiding its labels at distant zooms.
 */
export interface MapLayerScale {
  minZoom: number | null;
  maxZoom: number | null;
  /**
   * When true (the default), point icons and circle radii scale
   * smoothly with zoom via a MapLibre `interpolate` expression so
   * features don't look oversized when zoomed out. When false, sizes
   * stay pinned to the style's numeric value at every zoom level.
   */
  scaleWithZoom: boolean;
  labelsMinZoom: number | null;
  labelsMaxZoom: number | null;
}

/**
 * Rendering strategies.
 *
 * - `simple`: use the colors in `MapLayerStyle` for every feature.
 * - `unique-values`: pick a color per distinct value of `field` from
 *   `categories`; fall back to the simple color for anything not in
 *   the list.
 * - `class-breaks`: map a numeric field to colors by bucket. `stops`
 *   are ascending threshold values; `colors` has exactly
 *   `stops.length + 1` entries, the first for input < stops[0], the
 *   last for input >= stops[stops.length - 1].
 */
export type MapLayerRenderer =
  | { kind: 'simple' }
  | {
      kind: 'unique-values';
      field: string;
      categories: MapUniqueValueCategory[];
    }
  | {
      kind: 'class-breaks';
      field: string;
      stops: number[];
      colors: string[];
    };

export interface MapUniqueValueCategory {
  /** Distinct value of the field, coerced to string. */
  value: string;
  color: string;
}

export type MapFilterOp =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'is-null'
  | 'is-not-null';

/**
 * A single where-clause. Stays string-typed so the editor stores a
 * stable shape; the viewer coerces numeric comparisons at render time.
 */
export interface MapLayerFilterClause {
  field: string;
  op: MapFilterOp;
  /** Unused for is-null / is-not-null. */
  value: string;
}

/**
 * Multi-clause filter. `combinator: 'all'` is AND (every clause must
 * match), `any` is OR (at least one). A single-clause filter is just a
 * MapLayerFilter with one entry; multi-clause boolean trees (nested
 * AND/OR) can land later if real workloads ask for them.
 */
export interface MapLayerFilter {
  combinator: 'all' | 'any';
  clauses: MapLayerFilterClause[];
}

/**
 * Layer data sources.
 *   - `geojson-url`: pulls from a public URL at load time.
 *   - `geojson-inline`: stores the GeoJSON body directly in the item
 *     (small datasets only: it lives in dataJson).
 *   - `feature-service`: references a portal item and will light up
 *     once that pillar ships.
 *   - `arcgis-rest`: points at a layer inside an ArcGIS Server
 *     MapServer or FeatureServer endpoint; the viewer queries
 *     `/<layerId>/query?...&f=geojson` live as the camera moves and
 *     paginates when the server reports `exceededTransferLimit`. The
 *     `serviceType` field is persisted so callers don't have to re-
 *     probe just to tell which REST vocabulary the server uses.
 */
export type MapLayerSource =
  | { kind: 'geojson-url'; url: string }
  | { kind: 'geojson-inline'; geojson: unknown }
  | { kind: 'data-layer'; itemId: string }
  | {
      kind: 'arcgis-rest';
      /** Root service URL, without the trailing /<layerId>. */
      url: string;
      /** Sub-layer id inside the service (usually a small integer). */
      layerId: number;
      /** MapServer or FeatureServer: persisted so we skip a probe. */
      serviceType: 'MapServer' | 'FeatureServer';
      /**
       * Optional back-reference to the arcgis_service portal item the
       * layer was added from, if any. When present, the dependency
       * tracker uses this id directly instead of doing URL-based
       * resolution. Layers added by pasting a raw URL (no portal item
       * backing them) simply omit this field and fall back to URL
       * matching.
       */
      sourceItemId?: string;
    };

/**
 * Simple-renderer style vocabulary, one section per geometry family.
 * A MapLibre layer is added per applicable family for a source, so a
 * mixed GeoJSON collection renders points + lines + polygons together.
 *
 * Colors are CSS / hex strings, rendered via MapLibre paint properties.
 */
/**
 * Which marker shape a point layer renders. `circle` keeps the
 * classic dot; `icon` swaps in a named symbol registered with
 * MapLibre via the map-icons library. Additional kinds (e.g. custom
 * uploaded SVG) slot in here.
 */
export type PointSymbol = 'circle' | 'icon';

export interface MapLayerStyle {
  point: {
    color: string;
    radius: number;
    strokeColor: string;
    strokeWidth: number;
    /**
     * Marker shape. `circle` (the default) uses color + radius +
     * outline; `icon` uses a pre-registered SVG referenced by name.
     */
    symbol: PointSymbol;
    /**
     * Required when symbol is `icon`. Names a built-in icon from the
     * MAP_ICONS registry (e.g. `"map-pin"`). Blank when using circle.
     */
    iconName: string;
    /** Multiplier applied to the icon's base 48px size. */
    iconSize: number;
    /**
     * When true, the icon renders via its SDF variant and is tinted
     * by `color`. When false, the icon uses its shipped colors as-
     * rendered from the SVG. Always off for raster uploads (PNG /
     * JPEG / etc.) since those can't be meaningfully SDF-encoded.
     */
    iconTint: boolean;
  };
  line: {
    color: string;
    width: number;
  };
  polygon: {
    fillColor: string;
    fillOpacity: number;
    strokeColor: string;
    strokeWidth: number;
  };
}

/**
 * Popup configuration. `enabled: false` disables click popups for this
 * layer entirely.
 *
 * `mode` picks how the body is rendered:
 *   - `all`: show every property on the feature (the default: zero-
 *     config for "just give me a popup").
 *   - `picked`: only show fields in `fields`, in that exact order.
 *   - `template`: render `bodyTemplate` as a Handlebars-lite string.
 *     Supports `{{field}}` interpolation and pipe-style formatters
 *     (`{{field | upper}}`, `{{date | date}}`, `{{n | number}}`,
 *     `{{v | currency}}`). HTML in the template is rendered as-is so
 *     authors can write small markup; values are always HTML-escaped.
 *
 * `titleTemplate` is an optional {{field}}-style string used for the
 * popup header. Empty falls back to the layer's own title.
 */
export interface MapLayerPopup {
  enabled: boolean;
  mode: 'all' | 'picked' | 'template';
  fields: string[];
  titleTemplate: string;
  bodyTemplate: string;
}

/**
 * Per-layer interaction toggles. `hoverHighlight` swaps to a lighter
 * paint while the cursor is over a feature. `editingEnabled` is a
 * forward-compatibility hint; editing UI only attaches to layers whose
 * source supports writes (feature-service, once it ships).
 */
export interface MapLayerInteractions {
  hoverHighlight: boolean;
  editingEnabled: boolean;
  /**
   * When true (the default), features on this layer can be picked via
   * the attribute table checkboxes, map click/rectangle/lasso/polygon
   * tools, and programmatic selection. When false, the layer is
   * effectively read-only for selection purposes: useful for
   * basemap-style overlays that shouldn't compete for attention.
   */
  selectable: boolean;
}

/**
 * Per-layer search configuration consumed by the map's search bar.
 * When `enabled` is true and `fields` is non-empty, the search bar
 * walks this layer's feature collection and emits results that match
 * a substring query against any of the listed fields.
 *
 * `labelTemplate` follows the same {{field}}-with-formatter grammar as
 * popups; empty means "use the first matching field's value".
 */
export interface MapLayerSearch {
  enabled: boolean;
  fields: string[];
  labelTemplate: string;
}

/**
 * Per-layer text labels. Renders as a MapLibre `symbol` layer on top
 * of the geometry. `placement: 'auto'` uses point-anchored labels for
 * points and polygons (centered), and follows the geometry for lines.
 *
 * `template` is a Handlebars-lite string with `{{field}}` interpolation
 * and optional `| formatter` pipes (`upper`, `lower`, `number`,
 * `currency`, `date`). Static text around tokens renders verbatim, so
 * `"Population: {{pop | number}}"` works as expected.
 *
 * `offsetX` / `offsetY` are in em (multiples of the text size) and are
 * handed straight to MapLibre's `text-offset` layout property. Positive
 * Y is *down* on screen; positive X is right. Typical usage is a small
 * positive Y to push a label below a point marker.
 */
export interface MapLayerLabels {
  enabled: boolean;
  /**
   * Handlebars-lite text expression. Empty string means "no label even
   * though enabled is true" (the renderer skips the symbol layer).
   */
  template: string;
  size: number;
  color: string;
  haloColor: string;
  haloWidth: number;
  placement: 'auto' | 'line';
  anchor: 'center' | 'top' | 'bottom' | 'left' | 'right';
  offsetX: number;
  offsetY: number;
}

/**
 * Freshly-created map with the defaults we want every new map to carry.
 * `basemap` is an empty-string sentinel; the server-side create path
 * (items.service) resolves it to the org's `seededKey='positron'`
 * basemap item so every new map opens with a usable default.
 */
export const DEFAULT_MAP: MapData = {
  version: 1,
  basemap: '',
  center: [-98.5795, 39.8283],
  zoom: 3,
  bearing: 0,
  pitch: 0,
  layers: [],
  search: {
    enabled: true,
    geocoding: true,
  },
};

/** Default paint for a fresh layer. Accent-adjacent so it's visible on any basemap. */
export const DEFAULT_LAYER_STYLE: MapLayerStyle = {
  point: {
    color: '#6366f1',
    radius: 6,
    strokeColor: '#ffffff',
    strokeWidth: 1.5,
    symbol: 'circle',
    iconName: '',
    iconSize: 1,
    iconTint: true,
  },
  line: {
    color: '#6366f1',
    width: 2,
  },
  polygon: {
    fillColor: '#6366f1',
    fillOpacity: 0.25,
    strokeColor: '#4338ca',
    strokeWidth: 1.5,
  },
};

export const DEFAULT_LAYER_POPUP: MapLayerPopup = {
  enabled: true,
  mode: 'all',
  fields: [],
  titleTemplate: '',
  bodyTemplate: '',
};

export const DEFAULT_LAYER_INTERACTIONS: MapLayerInteractions = {
  hoverHighlight: true,
  editingEnabled: false,
  selectable: true,
};

export const DEFAULT_LAYER_SEARCH: MapLayerSearch = {
  enabled: false,
  fields: [],
  labelTemplate: '',
};

export const DEFAULT_LAYER_LABELS: MapLayerLabels = {
  enabled: false,
  template: '',
  size: 12,
  color: '#111827',
  haloColor: '#ffffff',
  haloWidth: 1.5,
  placement: 'auto',
  anchor: 'top',
  offsetX: 0,
  offsetY: 1.1,
};

export const DEFAULT_LAYER_RENDERER: MapLayerRenderer = { kind: 'simple' };

export const DEFAULT_LAYER_SCALE: MapLayerScale = {
  minZoom: null,
  maxZoom: null,
  scaleWithZoom: true,
  labelsMinZoom: null,
  labelsMaxZoom: null,
};

export const DEFAULT_LAYER_ACCESS: MapLayerAccess = {
  policy: 'inherit',
  entries: [],
};

/**
 * MapLibre's widest permissible zoom range. We use these when a
 * layer's scale bound is `null`: MapLibre's default min/maxzoom
 * props have the same effect but being explicit keeps the emitted
 * layer spec easy to diff.
 */
export const ZOOM_MIN = 0;
export const ZOOM_MAX = 24;

/**
 * Palette used to auto-assign colors to unique-value categories. Chosen
 * to be colorblind-aware (Okabe–Ito–style distinctness) and to sit well
 * on both light and dark basemaps. Extend by appending; existing
 * categories keep the color that was picked at creation time.
 */
export const UNIQUE_VALUE_PALETTE: string[] = [
  '#0ea5e9',
  '#f97316',
  '#8b5cf6',
  '#10b981',
  '#ef4444',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
  '#6366f1',
  '#84cc16',
  '#06b6d4',
  '#d946ef',
];

/**
 * Sequential and diverging ramps for class-breaks rendering. Each ramp
 * is an ordered list of colors; the renderer picks as many as there are
 * classes via `sampleRamp`. Chosen for readability on typical basemaps;
 * more can be added without breaking persisted maps.
 */
export const CLASS_BREAK_RAMPS: Record<string, string[]> = {
  Blues: ['#eff6ff', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
  Greens: ['#f0fdf4', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'],
  Oranges: ['#fff7ed', '#fed7aa', '#fb923c', '#ea580c', '#7c2d12'],
  Reds: ['#fef2f2', '#fecaca', '#f87171', '#dc2626', '#7f1d1d'],
  Viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  Spectral: ['#3288bd', '#99d594', '#e6f598', '#fdae61', '#d53e4f'],
};

export const DEFAULT_CLASS_BREAK_RAMP = 'Viridis';

/**
 * Linearly sample a ramp down to exactly `n` colors. If `n` matches the
 * ramp length we return it verbatim; otherwise pick evenly-spaced
 * entries. Guarantees the first and last ramp colors are preserved so
 * the extremes are visually stable as the class count changes.
 */
export function sampleRamp(ramp: string[], n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [ramp[Math.floor(ramp.length / 2)]!];
  if (ramp.length === n) return [...ramp];
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const idx = Math.round(t * (ramp.length - 1));
    out.push(ramp[idx]!);
  }
  return out;
}
