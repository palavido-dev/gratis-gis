// SPDX-License-Identifier: AGPL-3.0-or-later
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
    description:
      'USGS National Map aerial imagery. US coverage only; orgs serving other regions should add their own basemap item.',
    tileUrl:
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery (c) U.S. Geological Survey, The National Map',
  },
];

/**
 * #211: one entry in a map's elevation mosaic stack. `itemId`
 * references a tile_layer with `dem: true`; `tileUrl` / `maxZoom`
 * are stamped from the item at set time so runtimes can render a
 * single-entry stack (the client-side cog:// path) and pick a
 * sensible source maxzoom without fetching items.
 */
export interface TerrainStackEntry {
  itemId: string;
  tileUrl: string;
  /** Native max web-mercator zoom of the DEM, when known. */
  maxZoom?: number;
}

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
  /**
   * #186: 3D terrain. When set, the canvas registers a raster-dem
   * source from the referenced elevation layer (a tile_layer with
   * `dem: true`) and calls setTerrain, so every layer in the map
   * (basemap, imagery overlays, features) drapes over the real
   * ground surface. tileUrl is stamped at set time (cog:// URL,
   * WITHOUT the #dem fragment; consumers append it) so runtimes
   * never need an item fetch to render, same rule as layers.
   *
   * #211: `stack` is the elevation mosaic. MapLibre only supports
   * one terrain mesh per map, so instead of one DEM item the map
   * carries an ORDERED list of them: index 0 has the highest
   * priority, and the server-side mosaic endpoint composes tiles
   * per pixel (first entry with data wins, nodata falls through to
   * the next entry down). Runtime rule: `stack` wins when present;
   * the legacy `itemId` / `tileUrl` pair stays populated as a
   * mirror of stack[0] so old runtimes, exports, and the
   * single-entry fast path keep working with no migration. A map
   * with only the legacy pair behaves as a stack of one. Entries
   * stamp `tileUrl` / `maxZoom` at set time (same
   * no-runtime-item-fetch rule as above); the mosaic endpoint
   * re-resolves everything server-side from `itemId` and never
   * trusts the stamped URL.
   */
  terrain?: {
    itemId: string;
    tileUrl: string;
    /** Vertical exaggeration, 1 = true scale. Default 1. */
    exaggeration?: number;
    /** #211: ordered elevation mosaic; stack[0] wins per pixel. */
    stack?: TerrainStackEntry[];
    /**
     * #211 follow-up (user feedback): 3D on/off WITHOUT losing the
     * stack. Turning 3D off used to delete the terrain key, which
     * wiped a carefully ordered stack; now it just flips this flag
     * so 2D peeking round-trips. ABSENT MEANS ON: every map saved
     * before this field exists has terrain configured because the
     * author wanted it rendered.
     */
    enabled?: boolean;
  };
  /**
   * #79: optional reference to a geo_boundary item that scopes the
   * VIEW of every layer in this map to features intersecting the
   * polygon. Distinct from `defaultExtentBoundaryId` (which only
   * frames the camera): this clips data the runtime sees.
   *
   * **Trust posture: this is NOT access control.** The clip is a
   * UX-level "default view scope" that the runtime applies on the
   * read path. The underlying layers still serve their full data
   * through their own URLs; anyone who can read those layers
   * directly will see the unclipped data. For real access control
   * use share geo limits on each layer (per-share polygon) or
   * tier-level geo limits on the layer item (#80) -- those are
   * enforced at the API layer for that access path.
   *
   * Used for city / county sandbox maps, demo / public landing
   * maps clipped to one region, and partner-org iframe embeds.
   * The label in the map editor reads "Default view scope" rather
   * than "Restrict to" so authors aren't tempted to treat it as
   * a security primitive.
   */
  clipBoundaryId?: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  /**
   * Ordered list of operational layers. Index 0 is the TOP of the
   * render stack (drawn on top of everything below it) and the TOP
   * of the LayerList display. The runtime's syncOverlays iterates
   * this array in reverse to add MapLibre layers in the right
   * stacking order. Matches the universal layered-graphics
   * convention (QGIS, ArcGIS Pro's contents pane, Photoshop,
   * Figma). Note this is the OPPOSITE of Esri's WebMap
   * `operationalLayers` contract, where index 0 is drawn FIRST and
   * therefore sits at the BOTTOM of the stack; the WebMap JSON
   * converters reverse the array at both the export and import
   * boundaries.
   */
  layers: MapLayer[];
  search: MapSearchConfig;
  /**
   * #154: per-author markup overlays. Each entry is a
   * `DrawingSet` (see `./drawings.ts`); the type is intentionally
   * imported and re-exported lazily to keep this file from growing
   * a dependency on the drawings module's helpers. Absent or empty
   * means "no markup on this map yet."
   *
   * Drawings are NOT data layers and do not appear in `layers`.
   * They render as a final overlay above every data layer; the
   * Markup pane in the editor is their authoring home.
   */
  drawings?: import('./drawings').DrawingSet[];
  /**
   * #154: opt-in flag that lets anonymous public viewers add
   * their own drawing sets to this map. Off by default; admins
   * turn it on per-map. Signed-in viewers can always add their
   * own sets when they have view access regardless of this flag.
   * The rate-limit + optional captcha gates apply to anonymous
   * writes the same way they do for anonymous tool-run.
   */
  allowAnonymousDrawings?: boolean;
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
  /**
   * Optional UUID of a geocoding_service item (#74) or an
   * arcgis_geocode-protocol service item (#75) that should be used
   * as the geocoding source for this map. When set, the search bar
   * queries the picked geocoder instead of Nominatim; when unset
   * AND `geocoding: true`, falls back to Nominatim.
   *
   * The map runtime fetches candidates from
   * `/api/portal/geocode/:geocoderId` (for geocoding_service items)
   * with the caller's auth. Items the viewer can't read 404 cleanly
   * and the search bar surfaces "no geocoder available" rather than
   * silently falling back to a service they didn't pick.
   */
  geocoderId?: string;
}

export interface MapLayer {
  id: string;
  title: string;
  visible: boolean;
  /** 0-1 multiplier applied to all paint fill / stroke / circle alpha. */
  opacity: number;
  source: MapLayerSource;
  /**
   * Optional pointer at a sibling layer whose `source.kind === 'group'`.
   * When set, this layer renders nested under that group header in the
   * layer panel. The map canvas ignores groupId entirely -- it just
   * filters out group-source layers and renders the leaves. See #46.
   */
  groupId?: string;
  style: MapLayerStyle;
  /**
   * How to color features: one color for everything, or one color per
   * distinct value of an attribute. `null` means use the simple style
   * colors as-is.
   */
  renderer: MapLayerRenderer;
  /**
   * #114: optional symbology overrides scoped to zoom ranges so one
   * layer can carry different looks at different scales without
   * forcing a duplicate layer (the AGO frustration where you'd add
   * "Parcels — overview" + "Parcels — detail" to a map and have to
   * maintain popups / labels / filters on both).
   *
   * Each class has its own style + renderer; everything else
   * (popup, filter, fields, search, sharing) stays singular on
   * the parent MapLayer.  At runtime the canvas evaluates which
   * class is active for the current zoom and applies that class's
   * paint via MapLibre step expressions.  Ranges are inclusive at
   * minZoom, exclusive at maxZoom; the first matching class wins.
   * When no class matches, the layer falls back to the base
   * `style` + `renderer` above.
   *
   * Today only `style` is respected at runtime; per-class renderer
   * overrides for unique-value / class-breaks compositions are a
   * follow-up since they require nesting attribute-driven expressions
   * inside the zoom-step expression -- doable, just not v1.
   */
  scaledSymbology?: ScaledSymbologyClass[];
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
   * Optional time-attribute window (#58). Null / undefined means the
   * layer carries every feature regardless of time. Drives the
   * server-side `?timeField=&timeFrom=&timeTo=` query params on
   * data_layer reads; the time-slider widget (#57) animates this
   * field at runtime by mutating from / to in place.
   */
  timeFilter?: MapLayerTimeFilter | null;
  /**
   * Optional per-layer geographic clip (#34). UUID of a geo_boundary
   * item whose geometry intersects every rendered feature. Reuses
   * the same boundary library admins build for share geo limits and
   * map default extents. Empty / undefined = no clip. Server-side
   * enforcement piggy-backs on the existing share geoLimit pipeline:
   * the API ANDs this boundary with any share-level geoLimit before
   * issuing the SELECT. Owner / admin do NOT bypass this clip
   * because it is layer-content scope, not access -- the author
   * explicitly chose to render only a subset of the underlying data.
   */
  boundaryFilterItemId?: string;
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
    }
  /**
   * #59: time-bins classification. Each feature's `field` attribute
   * is parsed as a timestamp and dropped into one of `bins` based
   * on which boundary it falls between. `boundaries` is N ISO-8601
   * timestamps in ascending order; `bins` has exactly N+1 entries
   * mirroring class-breaks' colors[] shape: bin[0] is "before
   * boundaries[0]", bin[N] is ">= boundaries[N-1]". Out-of-range
   * (null, non-ISO, undated) values fall to `defaultColor`.
   *
   * Distinct from class-breaks so the editor can render a date
   * picker per stop and so the canvas can do the timestamp parse
   * client-side (MapLibre's expressions can't ::cast strings to
   * dates, but they can string-compare ISO-8601 lexically because
   * the canonical Z-suffix form preserves order).
   */
  | {
      kind: 'time-bins';
      field: string;
      boundaries: string[];
      bins: { color: string; label?: string }[];
      defaultColor: string;
    };

export interface MapUniqueValueCategory {
  /** Distinct value of the field, coerced to string. */
  value: string;
  color: string;
  /**
   * #78: optional per-category icon override for point geometries.
   * When set AND the layer's point.symbol is 'icon', the canvas
   * builds a `match` expression on this field so each category
   * renders with its own icon (e.g. House values get the house
   * icon, Garage values get the garage icon). When unset, the
   * category falls back to the layer-level style.point.iconName so
   * the existing color-only behavior is preserved -- nothing
   * changes for renderers that don't opt in.
   *
   * Out of scope for v1: per-category overrides on line / polygon
   * (those are color-only in nearly every product), per-category
   * icon size / tint.
   */
  iconName?: string;
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
 * Time-attribute filter (#58). Restricts a layer's features to those
 * whose `field` attribute (a date or datetime column) falls inside
 * the [from, to] window. Either bound is optional for open-ended
 * windows. Stored alongside MapLayerFilter so a layer can carry
 * both a content filter and a time scope independently.
 *
 * Bounds are ISO-8601 strings. The renderer / engine reads them
 * straight; the time-slider widget (#57) updates them at runtime.
 */
export interface MapLayerTimeFilter {
  /** Attribute column to scope. Must reference a date / datetime
   *  field declared on the layer schema. */
  field: string;
  /** Inclusive lower bound (ISO-8601). Omit for open-ended below. */
  from?: string;
  /** Inclusive upper bound (ISO-8601). Omit for open-ended above. */
  to?: string;
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
  | {
      kind: 'data-layer';
      itemId: string;
      /**
       * Optional sublayer key for v3 multi-layer data_layer items.
       * When set, the renderer fetches
       * `/items/<itemId>/layers/<layerKey>/geojson` (the per-sublayer
       * v3 endpoint) instead of the legacy item-level
       * `/items/<itemId>/geojson` (which only exists for v1 inline /
       * v2 single-table items). The Add Layer dialog generates one
       * MapLayer per sublayer with this set when an author drops a
       * v3 data_layer onto the map; v1/v2 items omit it and continue
       * to hit the item-level endpoint.
       */
      layerKey?: string;
    }
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
      /**
       * Route the live bbox query through the portal-api proxy at
       * `/api/portal/items/:id/proxy` instead of `url` directly
       * (#36). Set when the source item is a credentialed
       * arcgis_service item (data.requiresAuth === true). The
       * proxy resolves the stored credential server-side and
       * forwards to the upstream URL; the browser never sees the
       * secret. `url` stays as the human-readable upstream URL so
       * "open service page" links still work.
       */
      proxyUrl?: string;
    }
  /**
   * #158 Live PostgreSQL + PostGIS read. References a service
   * item (`type='service'`, `protocol='postgis_live'`) by id and
   * a schema-qualified table name. The viewer issues bbox-filtered
   * GeoJSON fetches against the portal-api endpoint
   * `/items/:serviceId/postgis-live/features?layer=schema.table&bbox=...`,
   * which connects with the stored encrypted credential and returns
   * a FeatureCollection. No row of feature data ever lives in the
   * portal database itself.
   */
  | {
      kind: 'postgis-live';
      /** Service item id (`type='service'`, `protocol='postgis_live'`)
       *  whose connection credentials this layer borrows. */
      serviceItemId: string;
      /** Schema-qualified table name, e.g. "public.parcels". The
       *  probe step writes this in the wizard; authors don't type
       *  raw SQL. */
      tableName: string;
      /** Optional WHERE clause appended to every SELECT. Server-
       *  side validation refuses statement terminators and `;` so
       *  this can't smuggle in a second statement. Empty / unset
       *  means no filter. */
      whereClause?: string;
    }
  /**
   * Group "layer" -- a UI-only grouping marker. Group layers do not
   * render anything to the map; the canvas filters them out. The
   * layer panel renders them as expandable headers and stacks every
   * sibling layer with `groupId === this.id` under the header.
   * Toggling visibility / opacity on the header cascades to the
   * children. See #46.
   */
  /**
   * #179 unit 3: 3D point cloud layer backed by a point_cloud item.
   * The canvas mounts a lazily-loaded COPC streaming overlay when
   * any visible layer has this kind; nothing 3D loads otherwise.
   * Metadata is stamped at add time so rendering needs no item
   * fetch (it can go stale if the item's file is replaced; re-add
   * the layer to refresh -- acceptable for v1 and cheaper than a
   * per-render fetch on every runtime including anonymous ones).
   */
  | {
      kind: 'point-cloud';
      itemId: string;
      /** Streaming endpoint, from PointCloudData.dataUrl. The
       *  .copc.laz suffix is load-bearing (readers sniff it to
       *  enable viewport streaming). */
      dataUrl: string;
      /** WGS84 [w,s,e,n] from the item, for zoom-to-layer. */
      bboxWgs84?: [number, number, number, number];
      /** #211: the item's preferred elevation layer, stamped at add
       *  time so the builder can offer matching terrain without an
       *  item fetch. */
      preferredElevationItemId?: string;
      /** Total points, drives the size-aware streaming budget. */
      pointCount?: number;
      /** Whether the cloud carries RGB (drives default coloring). */
      hasRgb?: boolean;
      /** Persisted display choices for this layer. Each point-cloud
       *  layer gets its own overlay control instance, so these are
       *  honestly per-layer (user feedback: "settings should be
       *  tied to each individual layer"). */
      colorScheme?: 'elevation' | 'intensity' | 'classification' | 'rgb';
      pointSize?: number;
      /** Colormap for elevation/intensity coloring. Names mirror
       *  the matplotlib-style set the 3D overlay library ships. */
      colormap?:
        | 'viridis'
        | 'plasma'
        | 'inferno'
        | 'magma'
        | 'cividis'
        | 'turbo'
        | 'jet'
        | 'rainbow'
        | 'terrain'
        | 'coolwarm'
        | 'gray';
    }
  /**
   * #185: raster tile layer backed by a tile_layer item (uploaded
   * imagery, hillshade outputs from the analysis worker, and so
   * on) as an OVERLAY layer with opacity, not just a basemap
   * source. The canvas renders it as a MapLibre raster source
   * through the pmtiles/cog protocols. Vector tile caches are out
   * of scope here (they need authored styling; the basemap path
   * covers them). Metadata stamped at add time, same reasoning as
   * point-cloud.
   */
  | {
      kind: 'tile';
      itemId: string;
      /** pmtiles:// or cog:// URL from TileLayerData.tileUrl. */
      tileUrl: string;
      /** WGS84 [w, s, e, n] from the item, for zoom-to-layer. */
      bboxWgs84?: [number, number, number, number];
      /** #211: the item's preferred elevation layer, stamped at add
       *  time so the builder can offer matching terrain without an
       *  item fetch. */
      preferredElevationItemId?: string;
      attribution?: string;
    }
  | { kind: 'group' };

/**
 * Simple-renderer style vocabulary, one section per geometry family.
 * A MapLibre layer is added per applicable family for a source, so a
 * mixed GeoJSON collection renders points + lines + polygons together.
 *
 * Colors are CSS / hex strings, rendered via MapLibre paint properties.
 */
/**
 * Which marker shape a point layer renders (#73).
 *
 *   - `circle` keeps the classic dot.
 *   - `square` / `diamond` / `triangle` / `pin` / `star` paint a
 *     vector shape from a bundled sprite. Color + radius + outline
 *     apply the same way as `circle`.
 *   - `icon` composites a glyph from the bundled icon library on
 *     top of the shape underneath. When `shape` is `icon`, the
 *     `shapeUnder` field picks the colored shape to render
 *     beneath the glyph (the "AGO look" -- white badge inside a
 *     filled circle).
 *
 * Legacy `symbol` (typed as `'circle' | 'icon'`) is preserved on
 * the layer style as `shape` and `shapeUnder` for backward compat
 * with older items; the renderer reads new shapes first and falls
 * back to `symbol` when shape is unset.
 */
export type PointShape =
  | 'circle'
  | 'square'
  | 'diamond'
  | 'triangle'
  | 'pin'
  | 'star'
  | 'icon';

/**
 * Legacy alias kept so the older two-state field
 * (`symbol: 'circle' | 'icon'`) still typechecks while we
 * migrate. New code reads `shape` instead.
 */
export type PointSymbol = 'circle' | 'icon';

/**
 * Common stroke-dash presets that map cleanly onto MapLibre's
 * `line-dasharray` paint property (#73). The renderer expands
 * the preset into the dash + gap-length pair MapLibre wants. A
 * preset stays stable across line widths because MapLibre scales
 * the dash array by line width internally.
 */
export type DashStyle =
  | 'solid'
  | 'dash'
  | 'short-dash'
  | 'long-dash'
  | 'dash-dot'
  | 'dot'
  | 'dash-dot-dot';

/** MapLibre line-cap vocabulary, surfaced verbatim. */
export type LineCap = 'butt' | 'round' | 'square';

/** MapLibre line-join vocabulary, surfaced verbatim. */
export type LineJoin = 'bevel' | 'round' | 'miter';

/**
 * #114: per-zoom-range symbology class.  Carries its own style +
 * renderer; everything else on the parent MapLayer (popup, filter,
 * fields, sharing) stays singular.  Authoring lives in the
 * symbology panel as a list of classes; runtime in the map canvas
 * compiles these into MapLibre step expressions over the `zoom`
 * variable so transitions are pixel-perfect at the threshold.
 */
export interface ScaledSymbologyClass {
  /** Inclusive lower zoom bound (0-24).  Omit / null for
   *  "no lower bound" -- the class is active at zoom 0 unless a
   *  later class with a higher minZoom takes over. */
  minZoom?: number;
  /** Exclusive upper zoom bound (0-24).  Omit / null for
   *  "no upper bound". */
  maxZoom?: number;
  /** This class's own style.  Used to derive paint properties
   *  when zoom is inside the class's range. */
  style: MapLayerStyle;
  /** Renderer override -- ignored at runtime today, present so
   *  the data shape doesn't change when we plug in renderer-aware
   *  zoom-stepping. */
  renderer: MapLayerRenderer;
  /** Optional label shown in the symbology editor list (e.g.
   *  "Overview", "Detail").  Has no runtime effect. */
  label?: string;
}

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
    /**
     * #146: optional background shape rendered BENEATH the icon for
     * the AGO / Google-Maps "marker with icon" look. The renderer
     * emits an extra MapLibre circle layer underneath the symbol
     * layer when this is set, painted in backgroundFill +
     * backgroundStrokeColor at backgroundStrokeWidth pixels. Default
     * `'none'` so existing layers don't change appearance.
     *
     * Only meaningful when symbol is 'icon'; ignored for plain
     * circles (which already act as their own colored marker).
     */
    backgroundShape?: 'none' | 'circle' | 'rounded-square';
    /** Fill color for the background shape. Hex or rgba. */
    backgroundFill?: string;
    /** Outline color for the background shape. Hex or rgba. */
    backgroundStrokeColor?: string;
    /** Outline width in pixels. */
    backgroundStrokeWidth?: number;
  };
  line: {
    color: string;
    width: number;
    /** Dash preset (#73). Renderer expands this into a MapLibre
     *  line-dasharray pair. Missing field reads as `'solid'` so
     *  legacy layers don't change appearance. */
    dashStyle?: DashStyle;
    /** Stroke cap style; defaults to `'round'`. */
    cap?: LineCap;
    /** Stroke join style; defaults to `'round'`. */
    join?: LineJoin;
  };
  polygon: {
    fillColor: string;
    fillOpacity: number;
    strokeColor: string;
    strokeWidth: number;
    /** Same dash preset as `line.dashStyle`, applied to the
     *  polygon's outline stroke (#73). */
    strokeDashStyle?: DashStyle;
    strokeCap?: LineCap;
    strokeJoin?: LineJoin;
    /**
     * 3D extrusion by attribute (building footprints with a height
     * field, parcels by value, and so on). Renders through
     * MapLibre's native fill-extrusion layer, so this costs nothing
     * beyond the 2D pipeline: no deck.gl, no lazy 3D stack (that
     * remains point-cloud-only). Height per feature is
     * `to-number(properties[heightField]) * heightMultiplier` in
     * meters, clamped at zero; features whose field is missing or
     * non-numeric render flat. When enabled the extrusion layer
     * replaces the flat fill (outline stays), and the canvas raises
     * maxPitch the same way point-cloud layers do.
     */
    extrusion?: {
      enabled: boolean;
      /** Feature property holding the height value. */
      heightField: string;
      /** Multiplier applied to the raw value, default 1. Use for
       *  unit conversion (feet -> meters: 0.3048) or exaggeration. */
      heightMultiplier?: number;
      /** Base elevation offset in meters, default 0. */
      base?: number;
    };
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
  /** When true, clicking a feature opens a popup. The field is
   *  named `enabled` for backward compat (it existed before hover
   *  popups did); semantically reads as "click enables popup". */
  enabled: boolean;
  /**
   * When true, hovering a feature opens a preview popup at the
   *  cursor and closes it on mouseleave (#74 follow-up to a real
   *  user ask). Click + hover can both be on at the same time:
   *  the hover popup is the preview, the click popup is the
   *  pinned version. The content templates are shared.
   *
   *  Hover popups deliberately render from tile-side properties
   *  only (no per-hover API fetch) to keep the cursor-move handler
   *  cheap. For data_layer MVT features that means the popup shows
   *  whichever fields the tile carries; the user can click to get
   *  the full attribute fetch.
   */
  showOnHover?: boolean;
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
    backgroundShape: 'none',
    backgroundFill: '#ffffff',
    backgroundStrokeColor: '#111827',
    backgroundStrokeWidth: 1.5,
  },
  line: {
    color: '#6366f1',
    width: 2,
    dashStyle: 'solid',
    cap: 'round',
    join: 'round',
  },
  polygon: {
    fillColor: '#6366f1',
    fillOpacity: 0.25,
    strokeColor: '#4338ca',
    strokeWidth: 1.5,
    strokeDashStyle: 'solid',
    strokeCap: 'round',
    strokeJoin: 'round',
  },
};

/**
 * Map a `DashStyle` preset to the MapLibre `line-dasharray`
 * pair (dash length, gap length, ...) in line-width units (#73).
 * `'solid'` returns an empty array, which the renderer should
 * skip emitting so MapLibre falls back to its solid default
 * without going through a redundant per-segment dash-cap
 * resolution pass.
 *
 * The exact values come from tuning against MapLibre's default
 * vector tiles: small enough that dashes read as distinct at
 * mid zooms, large enough that they don't blur at low zooms.
 * Tuned for `line-cap: round` which is our default; flat-cap
 * lines will see slightly different visual ratios.
 */
export function dashArrayFor(style: DashStyle | undefined): number[] {
  switch (style) {
    case 'dash':
      return [4, 2];
    case 'short-dash':
      return [2, 2];
    case 'long-dash':
      return [8, 2];
    case 'dot':
      return [0.5, 2];
    case 'dash-dot':
      return [4, 2, 0.5, 2];
    case 'dash-dot-dot':
      return [4, 2, 0.5, 2, 0.5, 2];
    case 'solid':
    case undefined:
    default:
      return [];
  }
}

/** Human-readable label for a `DashStyle` preset, used in
 *  dropdown labels in the style editor (#73). */
export function dashStyleLabel(style: DashStyle): string {
  switch (style) {
    case 'solid':
      return 'Solid';
    case 'dash':
      return 'Dash';
    case 'short-dash':
      return 'Short dash';
    case 'long-dash':
      return 'Long dash';
    case 'dot':
      return 'Dotted';
    case 'dash-dot':
      return 'Dash-dot';
    case 'dash-dot-dot':
      return 'Dash-dot-dot';
  }
}

/** Ordered list of every dash-style preset, for dropdown
 *  enumeration. Adding a new preset requires updating
 *  `dashArrayFor` and `dashStyleLabel`. */
export const DASH_STYLES: DashStyle[] = [
  'solid',
  'dash',
  'short-dash',
  'long-dash',
  'dot',
  'dash-dot',
  'dash-dot-dot',
];

export const LINE_CAPS: LineCap[] = ['butt', 'round', 'square'];
export const LINE_JOINS: LineJoin[] = ['bevel', 'round', 'miter'];

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
 * Maximum nesting depth for group layers (#71). One root group plus
 * two more nested levels (so the deepest leaf has three group
 * ancestors). Enforced in the editor's "move to group" / "drag into
 * group" actions; the data model itself is not bounded so a future
 * relaxation would not require a migration.
 */
export const MAX_GROUP_DEPTH = 3;

/**
 * Walk a layer's group ancestry and intersect the zoom-range fields
 * of every ancestor group with the layer's own scale (#69). The
 * result is what the canvas should push onto the underlying MapLibre
 * layer's minzoom/maxzoom.
 *
 * Semantics:
 *   - minZoom takes the MAX of the layer's bound and every ancestor's
 *     (the tightest lower bound wins).
 *   - maxZoom takes the MIN of the layer's bound and every ancestor's
 *     (the tightest upper bound wins).
 *   - labelsMinZoom / labelsMaxZoom intersect the same way.
 *   - scaleWithZoom comes from the leaf only; groups don't override
 *     individual rendering knobs.
 *   - Cycle-safe: if the groupId chain ever loops, the visited set
 *     stops the walk before re-entry.
 *   - When the intersection produces an empty range
 *     (effectiveMinZoom > effectiveMaxZoom) the group has zoomed
 *     past where the leaf is allowed to render; MapLibre handles
 *     "min greater than max" gracefully by simply never rendering
 *     the layer, which is the desired behaviour.
 *
 * Lookup is by id; the caller passes the full layer list so the
 * helper can hop through groupId references without an external
 * map.
 */
export function effectiveLayerScale(
  layer: MapLayer,
  layers: MapLayer[],
): MapLayerScale {
  const own = layer.scale ?? DEFAULT_LAYER_SCALE;
  let min = own.minZoom;
  let max = own.maxZoom;
  let labelsMin = own.labelsMinZoom;
  let labelsMax = own.labelsMaxZoom;
  const visited = new Set<string>([layer.id]);
  let parentId: string | undefined = layer.groupId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = layers.find((l) => l.id === parentId);
    if (!parent || parent.source.kind !== 'group') break;
    const ps = parent.scale ?? DEFAULT_LAYER_SCALE;
    if (ps.minZoom != null) {
      min = min == null ? ps.minZoom : Math.max(min, ps.minZoom);
    }
    if (ps.maxZoom != null) {
      max = max == null ? ps.maxZoom : Math.min(max, ps.maxZoom);
    }
    if (ps.labelsMinZoom != null) {
      labelsMin =
        labelsMin == null ? ps.labelsMinZoom : Math.max(labelsMin, ps.labelsMinZoom);
    }
    if (ps.labelsMaxZoom != null) {
      labelsMax =
        labelsMax == null ? ps.labelsMaxZoom : Math.min(labelsMax, ps.labelsMaxZoom);
    }
    parentId = parent.groupId;
  }
  return {
    minZoom: min,
    maxZoom: max,
    scaleWithZoom: own.scaleWithZoom,
    labelsMinZoom: labelsMin,
    labelsMaxZoom: labelsMax,
  };
}

/**
 * Compute the depth of a group in the layer list (#71). A top-level
 * group has depth 1; a group whose groupId points at a top-level
 * group has depth 2; and so on. Non-group layers return 0. Used by
 * the panel to gate the "Add to group" / drag-into-group actions
 * against MAX_GROUP_DEPTH.
 *
 * Cycle-safe via the visited set.
 */
export function groupDepth(layer: MapLayer, layers: MapLayer[]): number {
  if (layer.source.kind !== 'group') return 0;
  let depth = 1;
  const visited = new Set<string>([layer.id]);
  let parentId: string | undefined = layer.groupId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = layers.find((l) => l.id === parentId);
    if (!parent || parent.source.kind !== 'group') break;
    depth += 1;
    parentId = parent.groupId;
  }
  return depth;
}

/**
 * #114: resolve a layer's effective MapLayerStyle at a specific
 * zoom level.  Walks the layer's scaledSymbology array and picks
 * the first class whose [minZoom, maxZoom) range contains the
 * given zoom.  Falls back to the layer's base style when no class
 * matches.  Used by the legend / LayerList swatch and by the
 * symbology editor's preview so authors see what each class will
 * actually look like.
 *
 * Class ranges:
 *   - minZoom is inclusive, maxZoom is exclusive
 *   - undefined minZoom means "0" (or "no lower bound")
 *   - undefined maxZoom means "infinity" (or "no upper bound")
 *   - overlapping classes have undefined behavior; the FIRST match
 *     in the array wins.  v1 leaves it to the author to keep
 *     ranges non-overlapping.
 */
export function effectiveStyleAtZoom(
  layer: MapLayer,
  zoom: number,
): MapLayerStyle {
  const classes = layer.scaledSymbology ?? [];
  for (const c of classes) {
    const min = c.minZoom ?? -Infinity;
    const max = c.maxZoom ?? Infinity;
    if (zoom >= min && zoom < max) return c.style;
  }
  return layer.style;
}

/**
 * #114: build a MapLibre `step` expression over `zoom` that picks
 * the right property value (color / number) from the active scaled
 * symbology class at each zoom level.  Returns the scalar base
 * value when the layer has no classes -- callers can drop this in
 * place of `style.X.Y` and the existing code paths keep working.
 *
 * Generic over the pick result so it threads through both string
 * (colors) and number (opacity, width, radius) properties without
 * losing type safety at the call site.
 *
 * Class ranges are inclusive at minZoom, exclusive at maxZoom; see
 * `effectiveStyleAtZoom` for the matching semantics.
 *
 * A gap between two non-adjacent classes returns to the base
 * style's value, so authors can paint a "different look between
 * z10 and z14" without affecting other zoom ranges.
 */
export function scaledStyleExpression<T extends string | number>(
  layer: MapLayer,
  pick: (style: MapLayerStyle) => T,
): T | unknown[] {
  const classes = layer.scaledSymbology ?? [];
  if (classes.length === 0) return pick(layer.style);
  const base = pick(layer.style);
  // Collect every boundary zoom at which the set of matching classes
  // can change: each class's start (minZoom, 0 when unbounded below)
  // and end (maxZoom, when bounded). Between two adjacent boundaries
  // no class starts or ends, so the effective value is constant
  // there. Sorting the unique boundary set ascending guarantees the
  // emitted stops are strictly ascending, which is a hard MapLibre
  // requirement: a step expression whose stops repeat or descend
  // fails expression validation, the paint property never registers,
  // and the layer silently renders blank. The previous per-class
  // transition emitter violated that whenever two classes shared a
  // minZoom or overlapped.
  const boundarySet = new Set<number>();
  for (const c of classes) {
    boundarySet.add(c.minZoom ?? 0);
    if (c.maxZoom !== undefined && c.maxZoom !== null) {
      boundarySet.add(c.maxZoom);
    }
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  // Value at each boundary: the FIRST class in authoring order whose
  // [minZoom, maxZoom) range contains that zoom, exactly mirroring
  // effectiveStyleAtZoom so the legend / editor preview and the
  // rendered map can never disagree. This also settles which class
  // wins at a shared boundary: where one class ends and another
  // starts at the same zoom, the ending class no longer matches
  // (maxZoom is exclusive) so the starting class wins; where two
  // classes start at the same zoom, the earlier one in the array
  // wins (first-match-wins). When no class matches, the layer
  // returns to the base style, which covers gaps between classes.
  const transitions = boundaries.map((zoom) => {
    const active = classes.find(
      (c) => zoom >= (c.minZoom ?? -Infinity) && zoom < (c.maxZoom ?? Infinity),
    );
    return { zoom, value: active ? pick(active.style) : base };
  });
  // MapLibre's step expression: ['step', input, default, stop1,
  // val1, stop2, val2, ...].  `default` is the value BEFORE the
  // first stop.  If the first transition is at zoom 0 we'd be
  // duplicating it as both the default AND a stop -- just collapse
  // by making the default the first transition's value and dropping
  // the first stop.
  let defaultValue: T = base;
  let stops = transitions;
  if (stops.length > 0 && stops[0]!.zoom <= 0) {
    defaultValue = stops[0]!.value;
    stops = stops.slice(1);
  }
  // Drop stops that repeat the value already in effect. Purely an
  // output-size nicety for well-formed inputs, but load-bearing for
  // overlapping classes: an overlapped class's start boundary often
  // resolves to the same first-match value as the range before it.
  const pruned: Array<{ zoom: number; value: T }> = [];
  let inEffect: T = defaultValue;
  for (const s of stops) {
    if (s.value === inEffect) continue;
    pruned.push(s);
    inEffect = s.value;
  }
  // No stops left after collapsing: one class (or one value)
  // covers the entire zoom range. Returning
  // `['step', ['zoom'], defaultValue]` here would be a zero-stop
  // step expression, which MapLibre rejects ("step has no stops").
  // The whole paint property silently fails to register and the
  // geometry vanishes (the WV Parcels symptom, where adding one
  // any-to-any class made the fill disappear). Return the resolved
  // value directly so callers see the same shape they'd get with
  // zero classes.
  if (pruned.length === 0) return defaultValue;
  const expr: unknown[] = ['step', ['zoom'], defaultValue];
  for (const s of pruned) {
    expr.push(s.zoom, s.value);
  }
  return expr;
}

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
