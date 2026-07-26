// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DataLayerFeaturesService } from '../../data-layer/features.service.js';
import { absoluteBase } from './url.js';
import { parseCollectionId, formatCollectionId } from './collection-id.js';

/**
 * OGC API Features Part 1 (Core + GeoJSON + OAS30 + Part 2 CRS) for
 * publicly-shared `data_layer` items. See `docs/ogc-api-strategy.md`
 * for the cross-class contract this controller honors:
 *
 *   - Single-layer items expose one collection with id `<itemId>`
 *     (v1 back-compat).
 *   - Multi-layer items expose one collection per layer with id
 *     `<itemId>__<layerKey>`. The bare `<itemId>` form keeps
 *     resolving to the first layer so existing integrations don't
 *     break.
 *   - CRS84 is the default output / bbox CRS; clients may request
 *     EPSG:4326 to get lat/lon axis order.
 *   - Sortby supports comma-separated property names, optional `-`
 *     prefix for descending.
 *
 * Conformance URIs are declared in `landing.controller.ts`. Adding a
 * new class means appending the URI there, not editing this file.
 *
 * All endpoints are anonymous and only see items with
 * `access = 'public'` (mirrors `/catalog.json`).
 */
@ApiTags('public', 'ogc', 'features')
@Controller('public/ogc/collections')
export class OgcFeaturesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly v3: DataLayerFeaturesService,
  ) {}

  @Public()
  @Get('/')
  async collections(@Req() req: Request) {
    const base = absoluteBase(req);
    const rows = await this.publicV3DataLayers();
    return {
      links: [
        {
          href: `${base}/api/public/ogc/collections`,
          rel: 'self',
          type: 'application/json',
        },
        {
          href: `${base}/api/public/ogc/`,
          rel: 'root',
          type: 'application/json',
        },
        {
          href: `${base}/api/public/ogc/conformance`,
          rel: 'conformance',
          type: 'application/json',
        },
      ],
      collections: rows.map((r) => collectionDoc(r, base)),
    };
  }

  @Public()
  @Get(':id')
  async collection(@Req() req: Request, @Param('id') id: string) {
    const row = await this.resolvePublicCollection(id);
    if (!row) throw new NotFoundException('Collection not found.');
    return collectionDoc(row, absoluteBase(req));
  }

  @Public()
  @Get(':id/items')
  async items(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('bbox') bboxParam?: string,
    @Query('bbox-crs') bboxCrsParam?: string,
    @Query('crs') crsParam?: string,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('sortby') sortbyParam?: string,
  ) {
    const row = await this.resolvePublicCollection(id);
    if (!row) throw new NotFoundException('Collection not found.');

    const limit = clamp(parseInt(limitParam ?? '', 10) || 100, 1, 10_000);
    const offset = Math.max(0, parseInt(offsetParam ?? '', 10) || 0);
    const crs = parseCrs(crsParam);
    const bboxCrs = parseCrs(bboxCrsParam);

    // Pre-2026-05-21: this handler called listFeatures with no limit
    // and sliced features.slice(offset, offset+limit) in JS. On a
    // 1.4M-row layer that meant the engine pulled every row + every
    // CTE-joined creates row before JS pagination, which on prod
    // tripped Postgres' statement_timeout and returned a 500 for
    // every items request (including limit=1). Push the limit down
    // into the engine's LIMIT clause. We over-fetch by `offset` so
    // the JS slice still gives correct pagination -- offset push-
    // down at the engine level is a follow-up; until then this caps
    // worst-case fetch at (offset + limit + 1), which is bounded by
    // the controller's limit clamp (10 000) plus whatever the caller
    // offset is.
    //
    // The `+ 1` is the next-page probe. With the fetch capped at
    // exactly offset + limit, the fetched count could never exceed
    // the window, so the `next` link never emitted and clients saw
    // every collection end after one page. Fetching one extra row
    // tells us cheaply whether another page exists; the probe row
    // is sliced off the response below.
    const fetchN = offset + limit + 1;
    const opts: {
      bbox?: [number, number, number, number];
      limit?: number;
    } = {
      limit: fetchN,
    };
    if (bboxParam) {
      opts.bbox = parseBbox(bboxParam, bboxCrs);
    }

    const fc = await this.v3.listFeatures(row.itemId, row.layerId, opts);

    let features = fc.features as Array<{
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry?: { coordinates?: unknown };
    }>;

    if (sortbyParam) {
      features = applySortby(features, sortbyParam);
    }

    // numberMatched is unknowable without a count-only query (which
    // would cost as much as the slow full-fetch we just avoided).
    // Per OGC API Features Part 1 7.18.2, numberMatched is OPTIONAL;
    // when omitted, clients fall back to relying on `next` link
    // presence to keep paging. We surface what we know (the size of
    // the slice we returned) as numberReturned and omit the field
    // entirely. Reporting the fetch-capped count as numberMatched
    // was a lie that told paging clients the collection ended at
    // whatever window they happened to request.
    const hasMore = features.length > offset + limit;
    let slice = features.slice(offset, offset + limit);
    if (crs === 'epsg-4326') {
      slice = slice.map(swapAxes);
    }

    const base = absoluteBase(req);
    const selfBase = `${base}/api/public/ogc/collections/${id}/items`;
    const links: Array<Record<string, string>> = [
      { href: selfBase, rel: 'self', type: 'application/geo+json' },
      {
        href: `${base}/api/public/ogc/collections/${id}`,
        rel: 'collection',
        type: 'application/json',
      },
    ];
    if (hasMore) {
      links.push({
        href: pagedUrl(selfBase, limit, offset + limit, bboxParam, sortbyParam, crsParam, bboxCrsParam),
        rel: 'next',
        type: 'application/geo+json',
      });
    }
    if (offset > 0) {
      links.push({
        href: pagedUrl(selfBase, limit, Math.max(0, offset - limit), bboxParam, sortbyParam, crsParam, bboxCrsParam),
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
      // OGC API Features Part 2 mandates the CRS URI on responses
      // when the client asked for a specific CRS. We always
      // include it so clients don't have to guess.
      crs:
        crs === 'epsg-4326'
          ? 'http://www.opengis.net/def/crs/EPSG/0/4326'
          : 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    };
  }

  /**
   * Single-feature lookup by stable entity id. Uses the existing
   * `entity` opt on `DataLayerFeaturesService.listFeatures` so the
   * underlying engine path is identical to the map-popup flow; only
   * the OGC envelope around the result differs.
   */
  @Public()
  @Get(':id/items/:featureId')
  async feature(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('featureId') featureId: string,
    @Query('crs') crsParam?: string,
  ) {
    const row = await this.resolvePublicCollection(id);
    if (!row) throw new NotFoundException('Collection not found.');
    const crs = parseCrs(crsParam);

    const fc = await this.v3.listFeatures(row.itemId, row.layerId, {
      entity: featureId,
    });
    const found = fc.features[0];
    if (!found) throw new NotFoundException('Feature not found.');
    const out = crs === 'epsg-4326' ? swapAxes(found) : found;
    const base = absoluteBase(req);
    return {
      ...out,
      links: [
        {
          href: `${base}/api/public/ogc/collections/${id}/items/${featureId}`,
          rel: 'self',
          type: 'application/geo+json',
        },
        {
          href: `${base}/api/public/ogc/collections/${id}`,
          rel: 'collection',
          type: 'application/json',
        },
      ],
    };
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  /**
   * Every public data_layer item, flattened to (item, layerId,
   * collectionId) rows. Multi-layer items expand into N rows so the
   * collections list shows one collection per layer; the first
   * layer is duplicated with the bare-UUID collection id so
   * existing single-layer integrations keep working unchanged.
   */
  private async publicV3DataLayers(): Promise<DataLayerRow[]> {
    const rows = await this.prisma.item.findMany({
      where: {
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        tags: true,
        license: true,
        updatedAt: true,
        data: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const out: DataLayerRow[] = [];
    for (const r of rows) {
      const layers = pickV3Layers(r.data);
      if (layers.length === 0) continue;
      // First layer also gets the bare-UUID alias (v1 back-compat).
      const first = layers[0]!;
      out.push({
        collectionId: r.id,
        itemId: r.id,
        layerId: first.id,
        title: layers.length > 1 ? `${r.title} / ${first.label ?? first.id}` : r.title,
        description: r.description,
        tags: r.tags,
        license: r.license,
        updatedAt: r.updatedAt,
      });
      // Multi-layer items also expose each layer (including the
      // first) under the explicit `<itemId>__<layerKey>` form so
      // discovery yields stable per-layer ids new clients can rely
      // on. The bare-UUID alias above keeps v1 callers working.
      if (layers.length > 1) {
        for (const lyr of layers) {
          out.push({
            collectionId: formatCollectionId(r.id, lyr.id),
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

  private async resolvePublicCollection(
    id: string,
  ): Promise<DataLayerRow | null> {
    const parsed = parseCollectionId(id);
    if (!parsed) return null;
    const item = await this.prisma.item.findFirst({
      where: {
        id: parsed.itemId,
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        tags: true,
        license: true,
        updatedAt: true,
        data: true,
      },
    });
    if (!item) return null;
    const layers = pickV3Layers(item.data);
    if (layers.length === 0) return null;
    let layerId: string;
    let layerLabel: string | undefined;
    if (parsed.layerKey === null) {
      // Bare UUID -> first layer (v1 back-compat).
      const first = layers[0]!;
      layerId = first.id;
      layerLabel = first.label ?? first.id;
    } else {
      const match = layers.find((l) => l.id === parsed.layerKey);
      if (!match) return null;
      layerId = match.id;
      layerLabel = match.label ?? match.id;
    }
    return {
      collectionId: id,
      itemId: item.id,
      layerId,
      title:
        layers.length > 1
          ? `${item.title} / ${layerLabel}`
          : item.title,
      description: item.description,
      tags: item.tags,
      license: item.license,
      updatedAt: item.updatedAt,
    };
  }
}

interface DataLayerRow {
  collectionId: string;
  itemId: string;
  layerId: string;
  title: string;
  description: string;
  tags: string[];
  license: string | null;
  updatedAt: Date;
}

interface V3LayerLite {
  id: string;
  label?: string;
}

function pickV3Layers(data: unknown): V3LayerLite[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as {
    version?: number;
    layers?: Array<{ id?: unknown; label?: unknown }>;
  };
  if (d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: V3LayerLite[] = [];
  for (const l of d.layers) {
    const id = l?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const label = typeof l?.label === 'string' ? l.label : undefined;
    out.push(label !== undefined ? { id, label } : { id });
  }
  return out;
}

function collectionDoc(
  row: DataLayerRow,
  base: string,
): Record<string, unknown> {
  const self = `${base}/api/public/ogc/collections/${row.collectionId}`;
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
    links: [
      { href: self, rel: 'self', type: 'application/json' },
      { href: `${self}/items`, rel: 'items', type: 'application/geo+json' },
      // OGC API - Tiles cross-link: clients walking the collection
      // graph reach the tileset metadata from here. Same collection
      // id; tmsId is fixed at WebMercatorQuad for v1.
      {
        href: `${self}/tiles/WebMercatorQuad`,
        rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector',
        type: 'application/json',
        title: 'Vector tileset (WebMercatorQuad)',
      },
      // OGC API - Styles cross-link: a curated default MapLibre
      // style is available at the same id.
      {
        href: `${base}/api/public/ogc/styles/${row.collectionId}`,
        rel: 'http://www.opengis.net/def/rel/ogc/1.0/styles',
        type: 'application/vnd.mapbox.style+json',
        title: 'Default MapLibre style',
      },
    ],
  };
}

function parseCrs(value: string | undefined): 'crs84' | 'epsg-4326' {
  if (!value) return 'crs84';
  const lower = value.toLowerCase();
  if (lower.endsWith('/crs/epsg/0/4326')) return 'epsg-4326';
  if (lower.endsWith('/crs/ogc/1.3/crs84')) return 'crs84';
  throw new BadRequestException(
    `Unsupported crs '${value}'. Supported: CRS84, EPSG:4326.`,
  );
}

function parseBbox(
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
 * Sort an array of GeoJSON features in place by one or more
 * property keys. `sortby` is comma-separated; an optional `-`
 * prefix marks descending. Unknown keys are silently ignored
 * (matches the OGC API Features Sortby extension; missing
 * properties don't 400, they just sort to the end).
 */
function applySortby<
  T extends { properties?: Record<string, unknown> },
>(features: T[], sortby: string): T[] {
  const keys = sortby
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s.startsWith('-')) return { key: s.slice(1), dir: -1 as const };
      if (s.startsWith('+')) return { key: s.slice(1), dir: 1 as const };
      return { key: s, dir: 1 as const };
    });
  if (keys.length === 0) return features;
  return [...features].sort((a, b) => {
    for (const { key, dir } of keys) {
      const av = a.properties?.[key];
      const bv = b.properties?.[key];
      const cmp = compareValues(av, bv);
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
}

function compareValues(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Swap GeoJSON coordinate axes (lon/lat <-> lat/lon). The engine
 * stores and returns CRS84 (lon/lat); when the OGC client requests
 * EPSG:4326 we swap on the way out per Features Part 2.
 *
 * Recurses through every coordinate position; works for Point,
 * LineString, Polygon, Multi*, and GeometryCollection. Geometry is
 * accepted as `unknown` because the engine's row shape types it that
 * way; we narrow defensively inside.
 */
function swapAxes<T extends { geometry?: unknown }>(feature: T): T {
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
      geometries: g.geometries.map((sub) =>
        swapGeometry(sub as GeometryLike),
      ),
    };
  }
  if (g.coordinates === undefined) return g;
  return { ...g, coordinates: swapCoords(g.coordinates) };
}

function swapCoords(c: unknown): unknown {
  if (!Array.isArray(c)) return c;
  // Position (a Point's coordinates): [lon, lat] -> [lat, lon].
  // Detected by "all entries are numbers AND length >= 2".
  if (
    c.length >= 2 &&
    typeof c[0] === 'number' &&
    typeof c[1] === 'number'
  ) {
    const [x, y, ...rest] = c as number[];
    return [y, x, ...rest];
  }
  return c.map(swapCoords);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function pagedUrl(
  selfBase: string,
  limit: number,
  offset: number,
  bbox: string | undefined,
  sortby: string | undefined,
  crs: string | undefined,
  bboxCrs: string | undefined,
): string {
  const url = new URL(selfBase);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (bbox) url.searchParams.set('bbox', bbox);
  if (sortby) url.searchParams.set('sortby', sortby);
  if (crs) url.searchParams.set('crs', crs);
  if (bboxCrs) url.searchParams.set('bbox-crs', bboxCrs);
  return url.toString();
}
