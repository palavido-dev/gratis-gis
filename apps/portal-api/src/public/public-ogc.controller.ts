import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { V3FeaturesService } from '../features-v3/v3-features.service.js';

/**
 * OGC API Features (Part 1: Core) public surface (#66 part 2).
 *
 * Maps each public v3 data_layer item's first layer onto a single
 * collection. Collection ID is the item UUID; multi-layer items
 * surface only their first layer in v1 because the standard wants
 * "one collection = one feature class" and the portal's UI doesn't
 * yet expose layer ids back to clients in a discoverable way. The
 * remaining layers can be promoted to their own collections later
 * with a `<itemId>__<layerId>` ID scheme without breaking existing
 * integrators.
 *
 * Conformance is the minimum viable subset: Core + GeoJSON. We do
 * not advertise OpenAPI 3.0 conformance because we don't ship a
 * spec document yet; clients fall back to discovery via /collections.
 *
 * All endpoints are unauthenticated and only see items with
 * `access = 'public'` (mirrors /catalog.json).
 */
@ApiTags('public', 'ogc')
@Controller('public/ogc')
export class PublicOgcController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly v3: V3FeaturesService,
  ) {}

  @Public()
  @Get('conformance')
  conformance() {
    return {
      conformsTo: [
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
      ],
    };
  }

  @Public()
  @Get('collections')
  async collections(@Req() req: Request) {
    const base = absoluteBase(req);
    const items = await this.publicV3DataLayers();
    return {
      links: [
        {
          href: `${base}/api/public/ogc/collections`,
          rel: 'self',
          type: 'application/json',
        },
        {
          href: `${base}/api/public/ogc/conformance`,
          rel: 'conformance',
          type: 'application/json',
        },
      ],
      collections: items.map((row) => collectionDoc(row, base)),
    };
  }

  @Public()
  @Get('collections/:id')
  async collection(@Req() req: Request, @Param('id') id: string) {
    const row = await this.publicV3DataLayer(id);
    if (!row) throw new NotFoundException('Collection not found.');
    return collectionDoc(row, absoluteBase(req));
  }

  @Public()
  @Get('collections/:id/items')
  async items(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('bbox') bboxParam?: string,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ) {
    const row = await this.publicV3DataLayer(id);
    if (!row) throw new NotFoundException('Collection not found.');
    const layerId = row.layerId;

    const limit = clamp(parseInt(limitParam ?? '', 10) || 100, 1, 10_000);
    const offset = Math.max(0, parseInt(offsetParam ?? '', 10) || 0);

    const opts: {
      bbox?: [number, number, number, number];
      at?: string;
    } = {};
    if (bboxParam) {
      const parts = bboxParam.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [w, s, e, n] = parts as [number, number, number, number];
        opts.bbox = [w, s, e, n];
      }
    }

    const fc = await this.v3.listFeatures(id, layerId, opts);
    const total = fc.features.length;
    const slice = fc.features.slice(offset, offset + limit);

    const base = absoluteBase(req);
    const links: Array<Record<string, string>> = [
      {
        href: `${base}/api/public/ogc/collections/${id}/items`,
        rel: 'self',
        type: 'application/geo+json',
      },
      {
        href: `${base}/api/public/ogc/collections/${id}`,
        rel: 'collection',
        type: 'application/json',
      },
    ];
    if (offset + limit < total) {
      const next = new URL(`${base}/api/public/ogc/collections/${id}/items`);
      next.searchParams.set('limit', String(limit));
      next.searchParams.set('offset', String(offset + limit));
      if (bboxParam) next.searchParams.set('bbox', bboxParam);
      links.push({ href: next.toString(), rel: 'next', type: 'application/geo+json' });
    }
    if (offset > 0) {
      const prev = new URL(`${base}/api/public/ogc/collections/${id}/items`);
      prev.searchParams.set('limit', String(limit));
      prev.searchParams.set('offset', String(Math.max(0, offset - limit)));
      if (bboxParam) prev.searchParams.set('bbox', bboxParam);
      links.push({ href: prev.toString(), rel: 'prev', type: 'application/geo+json' });
    }

    return {
      type: 'FeatureCollection',
      timeStamp: new Date().toISOString(),
      numberMatched: total,
      numberReturned: slice.length,
      features: slice,
      links,
    };
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  /**
   * Every public data_layer item with at least one v3 layer. Returns
   * a flattened (item, first-layer-id) row so callers can address a
   * collection directly without re-walking the JSON each time.
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
      const layerId = pickFirstV3LayerId(r.data);
      if (!layerId) continue;
      out.push({
        id: r.id,
        title: r.title,
        description: r.description,
        tags: r.tags,
        license: r.license,
        updatedAt: r.updatedAt,
        layerId,
      });
    }
    return out;
  }

  private async publicV3DataLayer(id: string): Promise<DataLayerRow | null> {
    const r = await this.prisma.item.findFirst({
      where: { id, type: 'data_layer', access: 'public', deletedAt: null },
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
    if (!r) return null;
    const layerId = pickFirstV3LayerId(r.data);
    if (!layerId) return null;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      tags: r.tags,
      license: r.license,
      updatedAt: r.updatedAt,
      layerId,
    };
  }
}

interface DataLayerRow {
  id: string;
  title: string;
  description: string;
  tags: string[];
  license: string | null;
  updatedAt: Date;
  layerId: string;
}

function pickFirstV3LayerId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { version?: number; layers?: Array<{ id?: unknown }> };
  if (d.version !== 3 || !Array.isArray(d.layers) || d.layers.length === 0) {
    return null;
  }
  const lid = d.layers[0]?.id;
  return typeof lid === 'string' && lid.length > 0 ? lid : null;
}

function collectionDoc(
  row: DataLayerRow,
  base: string,
): Record<string, unknown> {
  const self = `${base}/api/public/ogc/collections/${row.id}`;
  const items = `${self}/items`;
  return {
    id: row.id,
    title: row.title,
    description: row.description || row.title,
    keywords: row.tags ?? [],
    ...(row.license ? { license: row.license } : {}),
    crs: ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'],
    storageCrs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    links: [
      { href: self, rel: 'self', type: 'application/json' },
      { href: items, rel: 'items', type: 'application/geo+json' },
    ],
  };
}

function absoluteBase(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    req.protocol ??
    'http';
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    req.headers.host ??
    'localhost';
  return `${proto}://${host}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
