// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * The controller-agnostic half of the OGC API Features surface.
 *
 * Two controllers serve Features: the anonymous one under
 * `/api/public/ogc` (public items only) and the authenticated one
 * under `/api/ogc` (everything the caller can read, clipped by their
 * share geo limits and row scope). Both speak the same spec, so the
 * paging envelope, CRS handling, bbox parsing, collection documents,
 * and the v3 layer expansion live here ONCE. The controllers keep
 * only what genuinely differs: who may see which item, and which
 * clips apply.
 *
 * Extracted from the public controller unchanged; its spec pins the
 * behavior of everything here.
 */

export interface CollectionRow {
  collectionId: string;
  itemId: string;
  layerId: string;
  title: string;
  description: string;
  tags: string[];
  license: string | null;
  updatedAt: Date;
}

export interface V3LayerLite {
  id: string;
  label?: string;
  geometryType?: string | null;
  editingPolicy?: 'all-rows' | 'own-rows-only';
}

export function pickV3Layers(data: unknown): V3LayerLite[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as {
    version?: number;
    layers?: Array<{
      id?: unknown;
      label?: unknown;
      geometryType?: unknown;
      editingPolicy?: unknown;
    }>;
  };
  if (d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: V3LayerLite[] = [];
  for (const l of d.layers) {
    const id = l?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry: V3LayerLite = { id };
    if (typeof l?.label === 'string') entry.label = l.label;
    // geometryType: null means a table sublayer (no geometry column
    // was provisioned); absent errs toward "spatial" to match
    // tables.service's convention.
    if (l && 'geometryType' in l) {
      entry.geometryType =
        typeof l.geometryType === 'string' ? l.geometryType : null;
    }
    if (l?.editingPolicy === 'own-rows-only') {
      entry.editingPolicy = 'own-rows-only';
    }
    out.push(entry);
  }
  return out;
}

/**
 * Expand items into one collection row per layer, with the
 * bare-UUID alias for the first layer (v1 back-compat). Which items
 * arrive here is each controller's authorization decision; this
 * only shapes them.
 */
export function expandCollectionRows(
  items: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    license: string | null;
    updatedAt: Date;
    data: unknown;
  }>,
): CollectionRow[] {
  const out: CollectionRow[] = [];
  for (const r of items) {
    const layers = pickV3Layers(r.data);
    if (layers.length === 0) continue;
    const first = layers[0]!;
    out.push({
      collectionId: r.id,
      itemId: r.id,
      layerId: first.id,
      title:
        layers.length > 1 ? `${r.title} / ${first.label ?? first.id}` : r.title,
      description: r.description,
      tags: r.tags,
      license: r.license,
      updatedAt: r.updatedAt,
    });
    if (layers.length > 1) {
      for (const lyr of layers) {
        out.push({
          collectionId: formatCollectionIdCore(r.id, lyr.id),
          itemId: r.id,
          layerId: lyr.id,
          title: `${r.title} / ${lyr.label ?? lyr.id}`,
          description: r.description,
          tags: r.tags,
          license: r.license,
          updatedAt: r.updatedAt,
        });
      }
    }
  }
  return out;
}

// Local spelling to avoid a circular import with collection-id.ts;
// asserted equal to formatCollectionId by the core spec.
function formatCollectionIdCore(itemId: string, layerKey: string): string {
  return `${itemId}__${layerKey}`;
}

export function collectionDoc(
  row: CollectionRow,
  ogcRoot: string,
  opts: { tilesAndStyles?: boolean } = {},
): CollectionDoc {
  const self = `${ogcRoot}/collections/${row.collectionId}`;
  const links: Array<Record<string, string>> = [
    { href: self, rel: 'self', type: 'application/json' },
    { href: `${self}/items`, rel: 'items', type: 'application/geo+json' },
  ];
  if (opts.tilesAndStyles) {
    links.push(
      {
        href: `${self}/tiles/WebMercatorQuad`,
        rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector',
        type: 'application/json',
        title: 'Vector tileset (WebMercatorQuad)',
      },
      {
        href: `${ogcRoot}/styles/${row.collectionId}`,
        rel: 'http://www.opengis.net/def/rel/ogc/1.0/styles',
        type: 'application/vnd.mapbox.style+json',
        title: 'Default MapLibre style',
      },
    );
  }
  return {
    id: row.collectionId,
    title: row.title,
    description: row.description || row.title,
    keywords: row.tags ?? [],
    ...(row.license ? { license: row.license } : {}),
    crs: [
      'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      'http://www.opengis.net/def/crs/EPSG/0/4326',
    ],
    storageCrs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    links,
  };
}

export function parseCrs(value: string | undefined): 'crs84' | 'epsg-4326' {
  if (!value) return 'crs84';
  const lower = value.toLowerCase();
  if (lower.endsWith('/crs/epsg/0/4326')) return 'epsg-4326';
  if (lower.endsWith('/crs/ogc/1.3/crs84')) return 'crs84';
  throw new BadRequestException(
    `Unsupported crs '${value}'. Supported: CRS84, EPSG:4326.`,
  );
}

export function parseBbox(
  value: string,
  bboxCrs: 'crs84' | 'epsg-4326',
): [number, number, number, number] {
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequestException(
      `Invalid bbox '${value}'. Expected 4 comma-separated numbers.`,
    );
  }
  let [a, b, c, d] = parts as [number, number, number, number];
  if (bboxCrs === 'epsg-4326') {
    // EPSG:4326 axis order is lat,lon,lat,lon -> swap to internal
    // lon,lat,lon,lat for the engine query.
    [a, b, c, d] = [b, a, d, c];
  }
  return [a, b, c, d];
}

/**
 * Swap GeoJSON coordinate axes (lon/lat <-> lat/lon). The engine
 * stores and returns CRS84 (lon/lat); when the OGC client requests
 * EPSG:4326 we swap on the way out per Features Part 2.
 */
export function swapAxes<T extends { geometry?: unknown }>(feature: T): T {
  if (!feature.geometry || typeof feature.geometry !== 'object') {
    return feature;
  }
  return {
    ...feature,
    geometry: swapGeometry(feature.geometry as GeometryLike),
  };
}

interface GeometryLike {
  type?: string;
  coordinates?: unknown;
  geometries?: unknown[];
}

function swapGeometry(g: GeometryLike): GeometryLike {
  if (Array.isArray(g.geometries)) {
    return {
      ...g,
      geometries: g.geometries.map((sub) => swapGeometry(sub as GeometryLike)),
    };
  }
  if (g.coordinates === undefined) return g;
  return { ...g, coordinates: swapCoords(g.coordinates) };
}

function swapCoords(c: unknown): unknown {
  if (!Array.isArray(c)) return c;
  if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
    const [x, y, ...rest] = c as number[];
    return [y, x, ...rest];
  }
  return c.map(swapCoords);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function pagedUrl(
  selfBase: string,
  limit: number,
  offset: number,
  bbox: string | undefined,
  crs: string | undefined,
  bboxCrs: string | undefined,
): string {
  const url = new URL(selfBase);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (bbox) url.searchParams.set('bbox', bbox);
  if (crs) url.searchParams.set('crs', crs);
  if (bboxCrs) url.searchParams.set('bbox-crs', bboxCrs);
  return url.toString();
}

export interface ItemsQuery {
  bboxParam?: string | undefined;
  bboxCrsParam?: string | undefined;
  crsParam?: string | undefined;
  limitParam?: string | undefined;
  offsetParam?: string | undefined;
  sortbyParam?: string | undefined;
}

export interface CollectionDoc {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  license?: string;
  crs: string[];
  storageCrs: string;
  links: Array<Record<string, string>>;
}

export interface FeatureCollectionPage {
  type: 'FeatureCollection';
  timeStamp: string;
  numberReturned: number;
  features: unknown[];
  links: Array<Record<string, string>>;
  crs: string;
}

/**
 * The whole /items paging envelope: sortby rejection, limit and
 * offset clamps, the over-fetch pagination with the next-page probe,
 * axis swapping, and the link set. Every behavior here carries a
 * hard-won comment in the git history of the public controller (the
 * 2026-05-21 pool storm, the missing next-link, the numberMatched
 * lie); one implementation keeps the two surfaces from re-learning
 * them separately.
 *
 * `listFeatures` receives the engine options this function derives
 * from the query; the caller adds its own authorization-derived
 * clips (public tier boundary, or share geo limit + row scope)
 * before handing the merged options to the engine.
 */
export async function buildItemsResponse(args: {
  query: ItemsQuery;
  itemsUrl: string;
  collectionUrl: string;
  listFeatures: (opts: {
    bbox?: [number, number, number, number];
    limit: number;
  }) => Promise<{ features: unknown[] }>;
}): Promise<FeatureCollectionPage> {
  const { query } = args;
  if (query.sortbyParam !== undefined) {
    throw new BadRequestException(
      'sortby is not supported yet on feature collections. ' +
        'Remove the parameter; items are returned in a stable ' +
        'feature-id order suitable for paging.',
    );
  }
  const limit = clamp(parseInt(query.limitParam ?? '', 10) || 100, 1, 10_000);
  const offset = Math.max(0, parseInt(query.offsetParam ?? '', 10) || 0);
  const MAX_OFFSET = 100_000;
  if (offset > MAX_OFFSET) {
    throw new BadRequestException(
      `offset beyond ${MAX_OFFSET} is not supported; narrow the ` +
        'result with a bbox filter, or page from the start using the ' +
        'returned next links.',
    );
  }
  const crs = parseCrs(query.crsParam);
  const bboxCrs = parseCrs(query.bboxCrsParam);

  const fetchN = offset + limit + 1;
  const opts: { bbox?: [number, number, number, number]; limit: number } = {
    limit: fetchN,
  };
  if (query.bboxParam) {
    opts.bbox = parseBbox(query.bboxParam, bboxCrs);
  }

  const fc = await args.listFeatures(opts);
  const features = fc.features as Array<{ geometry?: unknown }>;

  const hasMore = features.length > offset + limit;
  let slice = features.slice(offset, offset + limit);
  if (crs === 'epsg-4326') {
    slice = slice.map(swapAxes);
  }

  const links: Array<Record<string, string>> = [
    { href: args.itemsUrl, rel: 'self', type: 'application/geo+json' },
    { href: args.collectionUrl, rel: 'collection', type: 'application/json' },
  ];
  if (hasMore) {
    links.push({
      href: pagedUrl(
        args.itemsUrl, limit, offset + limit,
        query.bboxParam, query.crsParam, query.bboxCrsParam,
      ),
      rel: 'next',
      type: 'application/geo+json',
    });
  }
  if (offset > 0) {
    links.push({
      href: pagedUrl(
        args.itemsUrl, limit, Math.max(0, offset - limit),
        query.bboxParam, query.crsParam, query.bboxCrsParam,
      ),
      rel: 'prev',
      type: 'application/geo+json',
    });
  }

  return {
    type: 'FeatureCollection',
    timeStamp: new Date().toISOString(),
    numberReturned: slice.length,
    features: slice,
    links,
    crs:
      crs === 'epsg-4326'
        ? 'http://www.opengis.net/def/crs/EPSG/0/4326'
        : 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
  };
}
