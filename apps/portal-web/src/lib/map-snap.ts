// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Snapping to the features drawn on the map, on any layer, with a
 * marker that shows what snapped.
 *
 * terra-draw's own `toCoordinate` / `toLine` snapping only sees the
 * features in its own store: the sketch being drawn and the one
 * feature being reshaped. The map's layers are drawn by MapLibre from
 * their own sources, so a new feature could never be placed exactly on
 * an existing tree, building corner or road. `MapFeatureSnapper` finds
 * the nearest vertex (or, failing that, the nearest point on an edge)
 * among the features MapLibre has rendered within a pixel radius of
 * the pointer, on every visible operational layer, and hands it to
 * terra-draw through `snapping.toCustom`.
 *
 * It also draws the evidence on the map:
 *  - while the pointer is snapped, the target feature is outlined and
 *    the snap point is ringed;
 *  - every vertex of the sketch or the reshaped feature that landed on
 *    a snap stays marked for the rest of the edit session, so a vertex
 *    that sits on a neighbour because of snapping is told apart from
 *    one that merely looks close.
 *
 * Coordinates come from the rendered copy. For a vector-tile layer that
 * copy is quantised to the tile grid and simplified for the zoom, so
 * the snap is exact to the screen pixel, not to the stored double;
 * zoom in for survey-grade work.
 */

export type LngLat = [number, number];

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Pixel radius within which a pointer snaps. */
export const SNAP_RADIUS_PX = 12;

/** MapLibre style-layer ids every operational map layer is drawn with. */
const OPERATIONAL_PREFIX = 'gg:';

/** Style layers that draw text or decoration, never geometry to snap to. */
export function isSnappableStyleLayer(id: string): boolean {
  if (!id.startsWith(OPERATIONAL_PREFIX)) return false;
  return !/-(label|label-pt|icon-halo)$/.test(id);
}

/** Every vertex of a geometry, flattened. */
export function geometryVertices(g: GeoJSON.Geometry | null | undefined): LngLat[] {
  if (!g) return [];
  switch (g.type) {
    case 'Point':
      return [g.coordinates as LngLat];
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates as LngLat[];
    case 'MultiLineString':
    case 'Polygon':
      return (g.coordinates as LngLat[][]).flat();
    case 'MultiPolygon':
      return (g.coordinates as LngLat[][][]).flat(2);
    case 'GeometryCollection':
      return g.geometries.flatMap(geometryVertices);
    default:
      return [];
  }
}

/** Every straight edge of a geometry, as coordinate pairs. */
export function geometrySegments(g: GeoJSON.Geometry | null | undefined): Array<[LngLat, LngLat]> {
  if (!g) return [];
  const fromPath = (path: LngLat[]): Array<[LngLat, LngLat]> => {
    const out: Array<[LngLat, LngLat]> = [];
    for (let i = 1; i < path.length; i++) out.push([path[i - 1]!, path[i]!]);
    return out;
  };
  switch (g.type) {
    case 'LineString':
      return fromPath(g.coordinates as LngLat[]);
    case 'MultiLineString':
    case 'Polygon':
      return (g.coordinates as LngLat[][]).flatMap(fromPath);
    case 'MultiPolygon':
      return (g.coordinates as LngLat[][][]).flat().flatMap(fromPath);
    case 'GeometryCollection':
      return g.geometries.flatMap(geometrySegments);
    default:
      return [];
  }
}

export interface NearestSnapOptions {
  project: (c: LngLat) => ScreenPoint;
  unproject: (p: ScreenPoint) => LngLat;
  radiusPx: number;
}

export interface SnapHit {
  coordinate: LngLat;
  /** Index into the `geometries` passed in: the feature snapped to. */
  index: number;
  kind: 'vertex' | 'edge';
}

/**
 * Where a pointer at `cursor` snaps among `geometries`, or undefined
 * when nothing is within `radiusPx`. A vertex within the radius always
 * wins over an edge, so a corner is easy to hit; an edge is used only
 * when no vertex is close.
 */
export function nearestSnap(
  cursor: ScreenPoint,
  geometries: ReadonlyArray<GeoJSON.Geometry | null | undefined>,
  { project, unproject, radiusPx }: NearestSnapOptions,
): SnapHit | undefined {
  let best: SnapHit | undefined;
  let bestD = radiusPx;
  geometries.forEach((g, index) => {
    for (const v of geometryVertices(g)) {
      const p = project(v);
      const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
      if (d <= bestD) {
        bestD = d;
        best = { coordinate: [v[0], v[1]], index, kind: 'vertex' };
      }
    }
  });
  if (best) return best;

  let bestPoint: { p: ScreenPoint; index: number } | undefined;
  bestD = radiusPx;
  geometries.forEach((g, index) => {
    for (const [a, b] of geometrySegments(g)) {
      const pa = project(a);
      const pb = project(b);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.max(0, Math.min(1, ((cursor.x - pa.x) * dx + (cursor.y - pa.y) * dy) / len2));
      const q = { x: pa.x + t * dx, y: pa.y + t * dy };
      const d = Math.hypot(q.x - cursor.x, q.y - cursor.y);
      if (d <= bestD) {
        bestD = d;
        bestPoint = { p: q, index };
      }
    }
  });
  return bestPoint
    ? { coordinate: unproject(bestPoint.p), index: bestPoint.index, kind: 'edge' }
    : undefined;
}

/** Round to terra-draw's precision, so a placed vertex compares equal. */
export function roundCoord(c: LngLat, precision: number): LngLat {
  const f = 10 ** precision;
  return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
}

/**
 * Identity of a coordinate for "did this vertex land on a snap". Seven
 * decimals (about 1 cm): terra-draw rounds a placed coordinate its own
 * way, so the last digits of the same point can differ as doubles.
 */
export const coordKey = (c: LngLat) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

/**
 * The vertices of `features` that sit on one of `snapped`, each once.
 * Both sides are expected at the same precision (see roundCoord).
 */
export function placedSnapVertices(
  features: ReadonlyArray<{ geometry: GeoJSON.Geometry | null | undefined }>,
  snapped: ReadonlySet<string>,
): LngLat[] {
  const seen = new Set<string>();
  const out: LngLat[] = [];
  for (const f of features) {
    for (const v of geometryVertices(f.geometry)) {
      const k = coordKey(v);
      if (snapped.has(k) && !seen.has(k)) {
        seen.add(k);
        out.push([v[0], v[1]]);
      }
    }
  }
  return out;
}

/** The slice of a MapLibre map the snapper reads and draws on. */
export interface SnapMap {
  getStyle(): { layers?: Array<{ id: string }> } | undefined;
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{ geometry: GeoJSON.Geometry; properties?: Record<string, unknown> | null }>;
  project(c: LngLat): ScreenPoint;
  unproject(p: [number, number]): { lng: number; lat: number };
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: unknown): unknown;
  removeLayer(id: string): unknown;
}

/** The pointer event fields terra-draw passes to `toCustom`. */
export interface SnapPointerEvent {
  containerX: number;
  containerY: number;
}

const SOURCE_ID = 'gg-snap-indicator';
const LAYER_TARGET_LINE = 'gg-snap-target-line';
const LAYER_TARGET_POINT = 'gg-snap-target-point';
const LAYER_PLACED = 'gg-snap-placed';
const LAYER_LIVE = 'gg-snap-live';
const LAYERS = [LAYER_TARGET_LINE, LAYER_TARGET_POINT, LAYER_PLACED, LAYER_LIVE];

/** The marker colour: magenta reads on light and dark basemaps alike. */
export const SNAP_MARKER_COLOR = '#d946ef';

/**
 * Snaps a terra-draw pointer to the map's rendered features and draws
 * the snap markers. One per terra-draw instance; `dispose` removes the
 * markers' source and layers.
 */
export class MapFeatureSnapper {
  private target: GeoJSON.Geometry | null = null;
  private live: LngLat | null = null;
  private placed: LngLat[] = [];
  /** Every coordinate handed to terra-draw this session, rounded. */
  private readonly offered = new Set<string>();

  constructor(
    private readonly map: SnapMap,
    private readonly precision: number,
    private readonly radiusPx: number = SNAP_RADIUS_PX,
  ) {}

  /** terra-draw `snapping.toCustom`. */
  readonly snap = (
    event: SnapPointerEvent,
    context?: { currentId?: unknown },
  ): LngLat | undefined => {
    const hit = this.find(event, context?.currentId);
    if (!hit) {
      this.setLive(null, null);
      return undefined;
    }
    const c = roundCoord(hit.coordinate, this.precision);
    if (this.offered.size > 5000) this.offered.clear();
    this.offered.add(coordKey(c));
    this.setLive(c, hit.geometry);
    return c;
  };

  /**
   * Recompute which vertices of the features terra-draw holds landed on
   * a snap. Call it with the store snapshot after every change.
   */
  refreshPlaced(features: ReadonlyArray<{ geometry: GeoJSON.Geometry | null | undefined }>): void {
    this.placed = placedSnapVertices(features, this.offered);
    this.render();
  }

  /** Drop the pointer markers (pointer left, tool switched). */
  clearLive(): void {
    this.setLive(null, null);
  }

  /** End of an edit session: forget everything and clear the map. */
  reset(): void {
    this.offered.clear();
    this.placed = [];
    this.target = null;
    this.live = null;
    this.render();
  }

  dispose(): void {
    try {
      for (const id of LAYERS) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch {
      /* the map is already gone */
    }
  }

  private find(
    event: SnapPointerEvent,
    currentId: unknown,
  ): { coordinate: LngLat; geometry: GeoJSON.Geometry } | undefined {
    let layers: string[];
    try {
      layers = (this.map.getStyle()?.layers ?? []).map((l) => l.id).filter(isSnappableStyleLayer);
    } catch {
      return undefined; // style not loaded yet, or the map is gone
    }
    if (layers.length === 0) return undefined;
    const x = event.containerX;
    const y = event.containerY;
    const r = this.radiusPx;
    let rendered: ReturnType<SnapMap['queryRenderedFeatures']>;
    try {
      rendered = this.map.queryRenderedFeatures(
        [
          [x - r, y - r],
          [x + r, y + r],
        ],
        { layers },
      );
    } catch {
      return undefined;
    }
    // The feature being reshaped is still drawn at its old shape by its
    // layer; snapping onto that copy would pin a vertex where it was.
    const skip =
      typeof currentId === 'string' || typeof currentId === 'number' ? String(currentId) : null;
    const geometries = rendered
      .filter((f) => skip === null || String(f.properties?._global_id ?? '') !== skip)
      .map((f) => f.geometry);
    const hit = nearestSnap({ x, y }, geometries, {
      radiusPx: r,
      project: (c) => this.map.project(c),
      unproject: (p) => {
        const ll = this.map.unproject([p.x, p.y]);
        return [ll.lng, ll.lat];
      },
    });
    return hit ? { coordinate: hit.coordinate, geometry: geometries[hit.index]! } : undefined;
  }

  private setLive(c: LngLat | null, target: GeoJSON.Geometry | null): void {
    const same =
      (c === null && this.live === null) ||
      (c !== null && this.live !== null && c[0] === this.live[0] && c[1] === this.live[1]);
    if (same && target === this.target) return;
    this.live = c;
    this.target = target;
    this.render();
  }

  private data(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    if (this.target) {
      features.push({ type: 'Feature', properties: { role: 'target' }, geometry: this.target });
    }
    for (const c of this.placed) {
      features.push({
        type: 'Feature',
        properties: { role: 'placed' },
        geometry: { type: 'Point', coordinates: c },
      });
    }
    if (this.live) {
      features.push({
        type: 'Feature',
        properties: { role: 'live' },
        geometry: { type: 'Point', coordinates: this.live },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  private render(): void {
    const data = this.data();
    try {
      const src = this.map.getSource(SOURCE_ID) as
        { setData(d: GeoJSON.FeatureCollection): void } | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      if (data.features.length === 0) return;
      this.map.addSource(SOURCE_ID, { type: 'geojson', data });
      const isPoint = ['==', ['geometry-type'], 'Point'];
      this.map.addLayer({
        id: LAYER_TARGET_LINE,
        type: 'line',
        source: SOURCE_ID,
        filter: ['all', ['==', ['get', 'role'], 'target'], ['!', isPoint]],
        paint: { 'line-color': SNAP_MARKER_COLOR, 'line-width': 3, 'line-dasharray': [2, 1] },
      });
      this.map.addLayer({
        id: LAYER_TARGET_POINT,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['all', ['==', ['get', 'role'], 'target'], isPoint],
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': SNAP_MARKER_COLOR,
          'circle-stroke-width': 2,
        },
      });
      this.map.addLayer({
        id: LAYER_PLACED,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'role'], 'placed'],
        paint: {
          'circle-radius': 6,
          'circle-color': SNAP_MARKER_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      this.map.addLayer({
        id: LAYER_LIVE,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'role'], 'live'],
        paint: {
          'circle-radius': 8,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': SNAP_MARKER_COLOR,
          'circle-stroke-width': 3,
        },
      });
    } catch {
      /* style reloading; the next pointer move draws again */
    }
  }
}
