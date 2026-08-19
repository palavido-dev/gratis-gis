// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  isTileLayerData,
  type TileLayerData,
} from '@gratis-gis/shared-types';

/**
 * STAC projection over tile_layer items (#29).
 *
 * Everything here is a pure READ-SIDE projection of rows the portal
 * already stores: nothing new is persisted and nothing syncs. That is
 * the whole reason this is hand-built in NestJS rather than adopting
 * pgstac/stac-fastapi, which would mean a second service, a duplicated
 * metadata table, and re-implementing per-item authorization in
 * another language (docs/research/ecosystem-alignment-2026-08-17.md
 * section 2).
 *
 * Why it exists: QGIS has native STAC support in core since 3.42
 * (Data Source Manager browsing, spatial/temporal filters, footprints
 * on canvas), so a compliant endpoint puts GratisGIS rasters into
 * stock QGIS with no plugin installed.
 *
 * Shared by the public surface (/api/public/stac, public items only)
 * and the authed mirror (/api/stac, everything the caller can see).
 * Asset hrefs point at the existing tile-layer endpoints, which are
 * @Public with per-item ACL inside, so one URL serves both audiences
 * and a bearer key authenticates private rasters.
 */

export const STAC_VERSION = '1.1.0';

/**
 * The one collection this phase serves. All tile_layer items live in
 * it; point clouds would become a sibling 'point-clouds' collection
 * in a later phase rather than widening this one.
 */
export const RASTER_COLLECTION_ID = 'rasters';

/**
 * Declared conformance. The house rule from #28 applies with full
 * force: every URI below corresponds to behavior these controllers
 * actually implement (landing, conformance, collections, items,
 * GET + POST search with bbox / datetime / ids / collections /
 * intersects), and nothing is declared ahead of existing. An
 * over-declared conformsTo is worse than a short one, because
 * clients branch on it.
 */
export const STAC_CONFORMANCE = [
  'https://api.stacspec.org/v1.0.0/core',
  'https://api.stacspec.org/v1.0.0/collections',
  'https://api.stacspec.org/v1.0.0/ogcapi-features',
  'https://api.stacspec.org/v1.0.0/item-search',
  // The ogcapi-features class rides on OGC API Features Part 1; these
  // are the classes that make /collections/{id}/items a conforming
  // OAFeat surface (core behaviors, GeoJSON encoding, OAS3 /api doc).
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
] as const;

/** projection extension v2 (proj:code replaced proj:epsg). */
const PROJECTION_EXT =
  'https://stac-extensions.github.io/projection/v2.0.0/schema.json';
/** web-map-links extension: xyz + pmtiles link rel types, which map
 *  onto our two serving endpoints exactly. */
const WEB_MAP_LINKS_EXT =
  'https://stac-extensions.github.io/web-map-links/v1.2.0/schema.json';

export const STAC_GEOJSON_MEDIA_TYPE = 'application/geo+json';

/** Prisma select shared by every STAC read. */
export const STAC_ITEM_SELECT = {
  id: true,
  title: true,
  description: true,
  tags: true,
  license: true,
  bbox: true,
  createdAt: true,
  updatedAt: true,
  data: true,
} as const;

export interface StacItemRow {
  id: string;
  title: string;
  description: string;
  tags: string[];
  license: string | null;
  bbox: unknown;
  createdAt: Date;
  updatedAt: Date;
  data: unknown;
}

// -----------------------------------------------------------------
// Item + collection projection
// -----------------------------------------------------------------

type Bbox = [number, number, number, number];

function parseBbox(b: unknown): Bbox | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const arr = b as unknown[];
  if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  return arr as Bbox;
}

function bboxToGeometry(b: Bbox): Record<string, unknown> {
  const [w, s, e, n] = b;
  const epsilon = 1e-9;
  if (Math.abs(e - w) < epsilon && Math.abs(n - s) < epsilon) {
    return { type: 'Point', coordinates: [w, s] };
  }
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

function tileData(row: StacItemRow): TileLayerData | null {
  return isTileLayerData(row.data) ? row.data : null;
}

/**
 * The item's datetime is the upload time, falling back to the row's
 * createdAt. That is ingest time, not acquisition time; every
 * generic STAC producer falls back to this and it validates, but a
 * search for "summer 2024 imagery" will return items by when they
 * were uploaded. A capture-date field on upload is the honest fix
 * and is deliberately out of scope for phase 1 (research doc,
 * "known wart to decide on").
 */
export function itemDatetime(row: StacItemRow): Date {
  const data = tileData(row);
  if (data?.uploadedAt) {
    const t = new Date(data.uploadedAt);
    if (Number.isFinite(t.getTime()) && t.getTime() > 0) return t;
  }
  return row.createdAt;
}

/**
 * Project one tile_layer row into a STAC Item.
 *
 * `apiRoot` is the STAC surface serving the item (public or authed),
 * used for self/parent/root links so a client stays on the surface it
 * arrived through. `base` is the portal origin; asset hrefs always
 * point at the tile-layer endpoints, which are shared by both
 * audiences and enforce per-item ACL themselves.
 */
export function buildStacItem(
  row: StacItemRow,
  base: string,
  apiRoot: string,
): Record<string, unknown> {
  const data = tileData(row);
  const bbox = parseBbox(row.bbox) ?? (data ? parseBbox(data.bbox) : null);
  const dt = itemDatetime(row);

  const assets: Record<string, unknown> = {};
  const hasCog = Boolean(data?.cogStorageKey) || data?.format === 'cog';
  const hasPmtiles =
    Boolean(data?.pmtilesStorageKey) || data?.format === 'pmtiles';
  if (hasCog) {
    assets.cog = {
      href: `${base}/api/tile-layer/${row.id}/file.cog`,
      type: 'image/tiff; application=geotiff; profile=cloud-optimized',
      title: data?.dem
        ? 'Elevation model (Cloud-Optimized GeoTIFF)'
        : 'Cloud-Optimized GeoTIFF',
      roles: ['data'],
    };
  }
  if (hasPmtiles) {
    assets.pmtiles = {
      href: `${base}/api/tile-layer/${row.id}/file.pmtiles`,
      type: 'application/vnd.pmtiles',
      title: 'PMTiles tile pyramid',
      roles: ['data'],
    };
  }

  // web-map-links: the XYZ endpoint serves every tile_layer whatever
  // backs it (that is its whole purpose), so the link is
  // unconditional. Vector archives serve MVT bytes and raster ones
  // PNG; the media type follows the content so a client picks the
  // right decoder.
  const isVector = data?.kind === 'vector' || data?.tileType === 'mvt';
  const links: Array<Record<string, unknown>> = [
    {
      href: `${apiRoot}/collections/${RASTER_COLLECTION_ID}/items/${row.id}`,
      rel: 'self',
      type: STAC_GEOJSON_MEDIA_TYPE,
    },
    {
      href: `${apiRoot}/collections/${RASTER_COLLECTION_ID}`,
      rel: 'parent',
      type: 'application/json',
    },
    {
      href: `${apiRoot}/collections/${RASTER_COLLECTION_ID}`,
      rel: 'collection',
      type: 'application/json',
    },
    { href: `${apiRoot}/`, rel: 'root', type: 'application/json' },
    {
      href: isVector
        ? `${base}/api/tile-layer/${row.id}/tiles/{z}/{x}/{y}`
        : `${base}/api/tile-layer/${row.id}/tiles/{z}/{x}/{y}.png`,
      rel: 'xyz',
      type: isVector ? 'application/vnd.mapbox-vector-tile' : 'image/png',
      title: 'Web map tiles (XYZ)',
    },
    {
      href: `${base}/api/items/${row.id}`,
      rel: 'alternate',
      type: 'application/json',
      title: 'Portal item document',
    },
  ];
  if (hasPmtiles) {
    links.push({
      href: `${base}/api/tile-layer/${row.id}/file.pmtiles`,
      rel: 'pmtiles',
      type: 'application/vnd.pmtiles',
      title: 'PMTiles archive',
    });
  }

  const properties: Record<string, unknown> = {
    datetime: dt.toISOString(),
    created: row.createdAt.toISOString(),
    updated: row.updatedAt.toISOString(),
    title: row.title,
    description: row.description || row.title,
    // Constant on purpose: raster ingest always warps to the web
    // tile grid (tile-conversion normalizes COGs to EPSG:3857 and
    // PMTiles pyramids are WebMercatorQuad by construction), so the
    // assets' native CRS is not per-item state.
    'proj:code': 'EPSG:3857',
  };
  if (row.tags.length > 0) properties.keywords = row.tags;
  if (row.license) properties.license = row.license;
  if (typeof data?.minZoom === 'number') properties['gg:min_zoom'] = data.minZoom;
  if (typeof data?.maxZoom === 'number') properties['gg:max_zoom'] = data.maxZoom;

  return {
    type: 'Feature',
    stac_version: STAC_VERSION,
    stac_extensions: [PROJECTION_EXT, WEB_MAP_LINKS_EXT],
    id: row.id,
    collection: RASTER_COLLECTION_ID,
    geometry: bbox ? bboxToGeometry(bbox) : null,
    ...(bbox ? { bbox } : {}),
    properties,
    links,
    assets,
  };
}

/**
 * The rasters Collection document. Spatial extent is the union of
 * the item bboxes, computed from the caller-visible rows so the
 * public and authed surfaces each describe exactly what they serve.
 */
export function buildRasterCollection(
  rows: StacItemRow[],
  apiRoot: string,
): Record<string, unknown> {
  let union: Bbox | null = null;
  let earliest: Date | null = null;
  for (const row of rows) {
    const b = parseBbox(row.bbox);
    if (b) {
      union = union
        ? [
            Math.min(union[0], b[0]),
            Math.min(union[1], b[1]),
            Math.max(union[2], b[2]),
            Math.max(union[3], b[3]),
          ]
        : [...b];
    }
    const dt = itemDatetime(row);
    if (!earliest || dt < earliest) earliest = dt;
  }
  return {
    type: 'Collection',
    stac_version: STAC_VERSION,
    id: RASTER_COLLECTION_ID,
    title: 'Raster layers',
    description:
      'Imagery, elevation, and other raster layers hosted by this ' +
      'GratisGIS portal, served as Cloud-Optimized GeoTIFFs, PMTiles ' +
      'pyramids, and web map tiles.',
    // Items carry their own license when set; the collection is
    // heterogeneous by nature, which STAC spells 'other'.
    license: 'other',
    extent: {
      spatial: { bbox: [union ?? [-180, -90, 180, 90]] },
      temporal: {
        interval: [[earliest ? earliest.toISOString() : null, null]],
      },
    },
    links: [
      {
        href: `${apiRoot}/collections/${RASTER_COLLECTION_ID}`,
        rel: 'self',
        type: 'application/json',
      },
      { href: `${apiRoot}/`, rel: 'root', type: 'application/json' },
      { href: `${apiRoot}/`, rel: 'parent', type: 'application/json' },
      {
        href: `${apiRoot}/collections/${RASTER_COLLECTION_ID}/items`,
        rel: 'items',
        type: STAC_GEOJSON_MEDIA_TYPE,
      },
    ],
  };
}

// -----------------------------------------------------------------
// Search parameter parsing
// -----------------------------------------------------------------

export interface DatetimeFilter {
  /** Exact instant, when the query was a single timestamp. */
  instant?: Date;
  /** Inclusive interval bounds; null means open. */
  start?: Date | null;
  end?: Date | null;
}

export interface StacSearchParams {
  limit: number;
  offset: number;
  bbox?: Bbox;
  datetime?: DatetimeFilter;
  ids?: string[];
  collections?: string[];
  intersects?: GeoJsonGeometry;
}

/** Query/body member names Item Search declares here. Anything else
 *  is refused by name, per the #28 rule: an ignored filter is a
 *  wrong answer, not a convenience. */
export const SEARCH_PARAM_NAMES = [
  'limit',
  'offset',
  'bbox',
  'datetime',
  'ids',
  'collections',
  'intersects',
] as const;

export const ITEMS_PARAM_NAMES = [
  'limit',
  'offset',
  'bbox',
  'datetime',
] as const;

function parseDatetimeBoundary(raw: string, name: string): Date {
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) {
    throw new BadRequestException(
      `Invalid ${name} timestamp "${raw}". Use RFC 3339, e.g. ` +
        '2026-08-01T00:00:00Z.',
    );
  }
  return d;
}

/**
 * Parse the OAFeat/STAC datetime parameter: a single instant, or a
 * `start/end` interval where either side may be `..` (open).
 */
export function parseDatetime(raw: string): DatetimeFilter {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('datetime must not be empty.');
  }
  if (!trimmed.includes('/')) {
    return { instant: parseDatetimeBoundary(trimmed, 'datetime') };
  }
  const parts = trimmed.split('/');
  if (parts.length !== 2) {
    throw new BadRequestException(
      'datetime interval must be "start/end" with at most one "/".',
    );
  }
  const [rawStart, rawEnd] = parts as [string, string];
  const open = (s: string) => s === '..' || s === '';
  const start = open(rawStart)
    ? null
    : parseDatetimeBoundary(rawStart, 'datetime start');
  const end = open(rawEnd)
    ? null
    : parseDatetimeBoundary(rawEnd, 'datetime end');
  if (start === null && end === null) {
    throw new BadRequestException(
      'datetime interval cannot be open on both ends.',
    );
  }
  if (start && end && start.getTime() > end.getTime()) {
    throw new BadRequestException('datetime start is after its end.');
  }
  return { start, end };
}

export function parseBboxParam(raw: unknown): Bbox {
  const nums = Array.isArray(raw)
    ? raw.map((n) => Number(n))
    : String(raw)
        .split(',')
        .map((s) => Number(s.trim()));
  // 6 numbers is a 3D bbox; the vertical axis is dropped per spec.
  const flat =
    nums.length === 6 ? [nums[0]!, nums[1]!, nums[3]!, nums[4]!] : nums;
  if (flat.length !== 4 || !flat.every((n) => Number.isFinite(n))) {
    throw new BadRequestException(
      'bbox must be 4 (or 6) comma-separated numbers: ' +
        'west,south,east,north.',
    );
  }
  const [w, s, e, n] = flat as Bbox;
  if (s > n) {
    throw new BadRequestException('bbox south is greater than its north.');
  }
  return [w, s, e, n];
}

function parseStringList(raw: unknown, name: string): string[] {
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  if (list.length === 0) {
    throw new BadRequestException(`${name} must not be empty.`);
  }
  return list;
}

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

function parseIntersects(raw: unknown): GeoJsonGeometry {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        'intersects must be a GeoJSON geometry (JSON-encoded when ' +
          'passed as a query parameter).',
      );
    }
  }
  const geom = value as GeoJsonGeometry;
  if (
    !geom ||
    typeof geom !== 'object' ||
    typeof geom.type !== 'string' ||
    !GEOMETRY_TYPES.has(geom.type)
  ) {
    throw new BadRequestException(
      'intersects must be a GeoJSON geometry object.',
    );
  }
  return geom;
}

/**
 * Parse search parameters from either a query string (GET, all
 * values strings) or a JSON body (POST, native types). Unknown
 * members are the caller's responsibility to reject first (the
 * controllers run rejectUnknownParams / rejectUnknownMembers before
 * calling this).
 */
export function parseSearchParams(
  raw: Record<string, unknown>,
): StacSearchParams {
  const limitNum = raw.limit === undefined ? 100 : Number(raw.limit);
  if (!Number.isFinite(limitNum) || !Number.isInteger(limitNum)) {
    throw new BadRequestException('limit must be an integer.');
  }
  const limit = Math.min(1000, Math.max(1, limitNum));
  const offsetNum = raw.offset === undefined ? 0 : Number(raw.offset);
  if (!Number.isFinite(offsetNum) || !Number.isInteger(offsetNum) || offsetNum < 0) {
    throw new BadRequestException('offset must be a non-negative integer.');
  }
  const out: StacSearchParams = { limit, offset: offsetNum };
  if (raw.bbox !== undefined) out.bbox = parseBboxParam(raw.bbox);
  if (raw.datetime !== undefined) {
    out.datetime = parseDatetime(String(raw.datetime));
  }
  if (raw.ids !== undefined) out.ids = parseStringList(raw.ids, 'ids');
  if (raw.collections !== undefined) {
    out.collections = parseStringList(raw.collections, 'collections');
  }
  if (raw.intersects !== undefined) {
    if (out.bbox) {
      // The spec forbids combining them; honoring one silently would
      // be the exact wrong-answer shape #28 removed.
      throw new BadRequestException(
        'bbox and intersects cannot be combined; send one or the other.',
      );
    }
    out.intersects = parseIntersects(raw.intersects);
  }
  return out;
}

// -----------------------------------------------------------------
// Geometry: bbox-vs-GeoJSON intersection, exact for our footprints
// -----------------------------------------------------------------

type Pos = [number, number];

function positionsOf(coords: unknown, depth: number): Pos[] {
  // Flatten nested coordinate arrays down to positions. depth is the
  // nesting level: 0 = position, 1 = array of positions, etc.
  if (depth === 0) {
    const p = coords as number[];
    return [[Number(p[0]), Number(p[1])]];
  }
  const out: Pos[] = [];
  for (const c of (coords as unknown[]) ?? []) {
    out.push(...positionsOf(c, depth - 1));
  }
  return out;
}

function pointInBbox([x, y]: Pos, b: Bbox): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

/** Even-odd ray cast over one or more rings (holes included). */
function pointInRings(p: Pos, rings: Pos[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      const crosses =
        yi > p[1] !== yj > p[1] &&
        p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

function orient(a: Pos, b: Pos, c: Pos): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

function onSegment(a: Pos, b: Pos, p: Pos): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a1: Pos, a2: Pos, b1: Pos, b2: Pos): boolean {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

function bboxEdges(b: Bbox): Array<[Pos, Pos]> {
  const [w, s, e, n] = b;
  return [
    [
      [w, s],
      [e, s],
    ],
    [
      [e, s],
      [e, n],
    ],
    [
      [e, n],
      [w, n],
    ],
    [
      [w, n],
      [w, s],
    ],
  ];
}

function segmentTouchesBbox(a: Pos, b: Pos, box: Bbox): boolean {
  if (pointInBbox(a, box) || pointInBbox(b, box)) return true;
  return bboxEdges(box).some(([e1, e2]) => segmentsIntersect(a, b, e1, e2));
}

function ringsIntersectBbox(rings: Pos[][], box: Bbox): boolean {
  // (a) any ring vertex inside the box: boundaries touch.
  for (const ring of rings) {
    for (const p of ring) if (pointInBbox(p, box)) return true;
  }
  // (b) any box corner strictly inside the polygon (even-odd over all
  // rings, so a box sitting wholly inside a hole stays outside).
  const [w, s, e, n] = box;
  const corners: Pos[] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
  if (corners.some((c) => pointInRings(c, rings))) return true;
  // (c) any ring edge crossing any box edge, which catches crossings
  // that exchange no vertices at all.
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (
        bboxEdges(box).some(([e1, e2]) =>
          segmentsIntersect(ring[j]!, ring[i]!, e1, e2),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Exact intersection between an item's bbox footprint and an
 * arbitrary GeoJSON geometry, boundary-inclusive. Our footprints are
 * axis-aligned rectangles, which is what makes an exact test small
 * enough to carry without a geometry dependency: vertex-in-box,
 * box-corner-in-polygon (even-odd, so holes behave), and
 * edge-pair crossings cover every case including a box wholly inside
 * a ring, a ring wholly inside the box, a crossing that exchanges no
 * vertices, and a box inside a hole (which must NOT match).
 */
export function bboxIntersectsGeometry(
  box: Bbox,
  geom: GeoJsonGeometry,
): boolean {
  switch (geom.type) {
    case 'Point': {
      const [p] = positionsOf(geom.coordinates, 0);
      return p ? pointInBbox(p, box) : false;
    }
    case 'MultiPoint':
      return positionsOf(geom.coordinates, 1).some((p) =>
        pointInBbox(p, box),
      );
    case 'LineString': {
      const pts = positionsOf(geom.coordinates, 1);
      for (let i = 1; i < pts.length; i++) {
        if (segmentTouchesBbox(pts[i - 1]!, pts[i]!, box)) return true;
      }
      return pts.length === 1 ? pointInBbox(pts[0]!, box) : false;
    }
    case 'MultiLineString': {
      for (const line of (geom.coordinates as unknown[]) ?? []) {
        if (
          bboxIntersectsGeometry(box, {
            type: 'LineString',
            coordinates: line,
          })
        ) {
          return true;
        }
      }
      return false;
    }
    case 'Polygon': {
      const rings = ((geom.coordinates as unknown[]) ?? []).map((r) =>
        positionsOf(r, 1),
      );
      return ringsIntersectBbox(rings, box);
    }
    case 'MultiPolygon': {
      for (const poly of (geom.coordinates as unknown[]) ?? []) {
        if (
          bboxIntersectsGeometry(box, {
            type: 'Polygon',
            coordinates: poly,
          })
        ) {
          return true;
        }
      }
      return false;
    }
    case 'GeometryCollection':
      return (geom.geometries ?? []).some((g) =>
        bboxIntersectsGeometry(box, g),
      );
    default:
      return false;
  }
}

// -----------------------------------------------------------------
// In-memory filtering
// -----------------------------------------------------------------

function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function matchesDatetime(dt: Date, f: DatetimeFilter): boolean {
  if (f.instant) return dt.getTime() === f.instant.getTime();
  if (f.start && dt.getTime() < f.start.getTime()) return false;
  if (f.end && dt.getTime() > f.end.getTime()) return false;
  return true;
}

/**
 * Apply the search filters to caller-visible rows and page the
 * result. Filtering happens here, in memory, against exactly the
 * values the projection reports (datetime is uploadedAt, geometry is
 * the cached bbox), so a filter can never disagree with the items it
 * returns.
 *
 * The rows arrive from one SQL query that already applied the cheap
 * filters (item type, visibility, not deleted) and an ORDER BY; this
 * function preserves that order. Scale ceiling: a portal would need
 * tens of thousands of raster items before this scan mattered, and
 * item.bbox is a cached column, so the migration path to a SQL-side
 * bbox filter is mechanical when someone gets there.
 */
export function filterAndPage(
  rows: StacItemRow[],
  params: StacSearchParams,
): { matched: number; page: StacItemRow[] } {
  let filtered = rows;
  if (
    params.collections &&
    !params.collections.includes(RASTER_COLLECTION_ID)
  ) {
    filtered = [];
  }
  if (params.ids) {
    const wanted = new Set(params.ids);
    filtered = filtered.filter((r) => wanted.has(r.id));
  }
  if (params.bbox) {
    // A query bbox with west > east crosses the antimeridian, which
    // the spec explicitly allows; test it as the two boxes it is.
    const q = params.bbox;
    const queries: Bbox[] =
      q[0] > q[2]
        ? [
            [q[0], q[1], 180, q[3]],
            [-180, q[1], q[2], q[3]],
          ]
        : [q];
    filtered = filtered.filter((r) => {
      const b = parseBbox(r.bbox);
      return b !== null && queries.some((qq) => bboxesOverlap(b, qq));
    });
  }
  if (params.intersects) {
    const g = params.intersects;
    filtered = filtered.filter((r) => {
      const b = parseBbox(r.bbox);
      return b !== null && bboxIntersectsGeometry(b, g);
    });
  }
  if (params.datetime) {
    const f = params.datetime;
    filtered = filtered.filter((r) => matchesDatetime(itemDatetime(r), f));
  }
  return {
    matched: filtered.length,
    page: filtered.slice(params.offset, params.offset + params.limit),
  };
}

/**
 * Refuse unknown members of a POST /search body by name. Same house
 * rule as the query-string version in features-core (see #28): the
 * caller must learn their filter was not applied, because applying
 * none of it and returning 200 is a wrong answer. This is where
 * `query`, `filter`, `sortby` and `fields` land until they are
 * actually implemented.
 */
export function rejectUnknownMembers(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body ?? {}).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown search member(s): ${unknown.join(', ')}. ` +
        `This endpoint supports: ${allowed.join(', ')}. ` +
        'Unsupported filters are rejected rather than silently ' +
        'ignored so a filtered search can never return unfiltered ' +
        'results.',
    );
  }
}

/**
 * The ItemCollection envelope shared by /items and /search, with
 * OAFeat-style paging links driven by limit + offset.
 */
export function buildItemCollection(args: {
  rows: StacItemRow[];
  params: StacSearchParams;
  base: string;
  apiRoot: string;
  selfUrl: string;
  extraQuery?: Record<string, string>;
}): Record<string, unknown> {
  const { matched, page } = filterAndPage(args.rows, args.params);
  const features = page.map((r) => buildStacItem(r, args.base, args.apiRoot));
  const links: Array<Record<string, unknown>> = [
    { href: args.selfUrl, rel: 'self', type: STAC_GEOJSON_MEDIA_TYPE },
    { href: `${args.apiRoot}/`, rel: 'root', type: 'application/json' },
  ];
  const pageUrl = (offset: number): string => {
    const url = new URL(args.selfUrl);
    url.searchParams.set('limit', String(args.params.limit));
    url.searchParams.set('offset', String(offset));
    for (const [k, v] of Object.entries(args.extraQuery ?? {})) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  };
  if (args.params.offset + args.params.limit < matched) {
    links.push({
      href: pageUrl(args.params.offset + args.params.limit),
      rel: 'next',
      type: STAC_GEOJSON_MEDIA_TYPE,
    });
  }
  if (args.params.offset > 0) {
    links.push({
      href: pageUrl(Math.max(0, args.params.offset - args.params.limit)),
      rel: 'prev',
      type: STAC_GEOJSON_MEDIA_TYPE,
    });
  }
  return {
    type: 'FeatureCollection',
    timeStamp: new Date().toISOString(),
    numberMatched: matched,
    numberReturned: features.length,
    features,
    links,
  };
}
