// SPDX-License-Identifier: AGPL-3.0-or-later
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
import type { ItemType } from '@prisma/client';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { absoluteBase } from './url.js';

/**
 * OGC API - Records Part 1 Core (#116). Modern catalog surface
 * that replaces the legacy CSW XML protocol for clients that speak
 * the OGC API style; CSW stays up alongside indefinitely for
 * harvesters that haven't upgraded.
 *
 * Surface:
 *
 *   /api/public/ogc/records          - the catalog (records list)
 *   /api/public/ogc/records/{id}     - one record
 *
 * Every public item gets a record. The record's `links` point at
 * whatever class-specific surface the item supports: data_layers
 * carry collection + tileset + style links; web_apps carry a
 * link to the runtime URL; basemaps carry their style URL; etc.
 * That makes the catalog a single discovery doorway -- a Records-
 * aware client lands here, walks `links` per record, and reaches
 * Features / Tiles / Styles without needing to know the portal's
 * other endpoints in advance.
 *
 * Records are JSON documents matching the OGC API Records Part 1
 * core schema:
 *   id, type='Record', title, description, keywords, themes (omitted
 *   here -- we'd need a theme taxonomy), providers (omitted -- one
 *   provider per org would clutter when most callers don't care),
 *   created, updated, license, geometry (null for non-spatial,
 *   bbox geometry for spatial items), links.
 *
 * Conformance: ogcapi-records-1/conf/core + conf/json + conf/sorting.
 * OpenSearch + CQL2 filter are out of scope for v1 (same posture as
 * Features Part 1).
 */
@ApiTags('public', 'ogc', 'records')
@Controller('public/ogc/records')
export class OgcRecordsController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('/')
  async records(
    @Req() req: Request,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('q') q?: string,
    @Query('type') typeParam?: string,
    @Query('sortby') sortbyParam?: string,
  ) {
    const base = absoluteBase(req);
    const limit = clamp(parseInt(limitParam ?? '', 10) || 100, 1, 1000);
    const offset = Math.max(0, parseInt(offsetParam ?? '', 10) || 0);

    const where: {
      access: 'public';
      deletedAt: null;
      type?: ItemType;
      OR?: Array<Record<string, unknown>>;
    } = { access: 'public', deletedAt: null };
    if (typeParam && KNOWN_ITEM_TYPES.has(typeParam)) {
      where.type = typeParam as ItemType;
    }
    if (q && q.trim().length > 0) {
      const needle = q.trim();
      where.OR = [
        { title: { contains: needle, mode: 'insensitive' } },
        { description: { contains: needle, mode: 'insensitive' } },
        { tags: { has: needle } },
      ];
    }

    const orderBy = parseSortby(sortbyParam);
    const [total, rows] = await Promise.all([
      this.prisma.item.count({ where }),
      this.prisma.item.findMany({
        where,
        select: ITEM_SELECT,
        orderBy,
        skip: offset,
        take: limit,
      }),
    ]);

    const features = rows.map((r) => buildRecord(r, base));

    const selfBase = `${base}/api/public/ogc/records`;
    const links: Array<Record<string, string>> = [
      { href: selfBase, rel: 'self', type: 'application/json' },
      {
        href: `${base}/api/public/ogc/`,
        rel: 'root',
        type: 'application/json',
      },
    ];
    if (offset + limit < total) {
      links.push({
        href: pagedUrl(selfBase, limit, offset + limit, q, typeParam, sortbyParam),
        rel: 'next',
        type: 'application/json',
      });
    }
    if (offset > 0) {
      links.push({
        href: pagedUrl(
          selfBase,
          limit,
          Math.max(0, offset - limit),
          q,
          typeParam,
          sortbyParam,
        ),
        rel: 'prev',
        type: 'application/json',
      });
    }

    return {
      type: 'FeatureCollection',
      timeStamp: new Date().toISOString(),
      numberMatched: total,
      numberReturned: features.length,
      features,
      links,
    };
  }

  @Public()
  @Get(':recordId')
  async record(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ) {
    if (!UUID_RE.test(recordId)) {
      throw new NotFoundException('Record not found.');
    }
    const row = await this.prisma.item.findFirst({
      where: { id: recordId, access: 'public', deletedAt: null },
      select: ITEM_SELECT,
    });
    if (!row) throw new NotFoundException('Record not found.');
    return buildRecord(row, absoluteBase(req));
  }
}

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ITEM_SELECT = {
  id: true,
  title: true,
  description: true,
  type: true,
  tags: true,
  license: true,
  bbox: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ItemRow = {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  tags: string[];
  license: string | null;
  bbox: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** Known item types we serve. Mirrors the public catalog's allow-
 *  list; future types append additively. Kept here as a Set so the
 *  type-filter query parameter validation is O(1) without pulling
 *  in the larger Prisma enum reflection. */
const KNOWN_ITEM_TYPES: Set<string> = new Set([
  'data_layer',
  'map',
  'web_app',
  'form',
  'file',
  'dashboard',
  'report_template',
  'tool',
  'arcgis_service',
  'basemap',
  'geo_boundary',
  'pick_list',
  'layer_package',
  'service',
  'geocoding_service',
]);

function buildRecord(
  row: ItemRow,
  base: string,
): Record<string, unknown> {
  const self = `${base}/api/public/ogc/records/${row.id}`;
  const links: Array<Record<string, string>> = [
    { href: self, rel: 'self', type: 'application/json' },
    {
      href: `${base}/api/items/${row.id}`,
      rel: 'alternate',
      type: 'application/json',
      title: 'Portal item document',
    },
  ];

  // Per-type cross-links: a Records-aware client lands here, walks
  // these to reach the specific class-of-service the item supports.
  switch (row.type) {
    case 'data_layer':
      links.push(
        {
          href: `${base}/api/public/ogc/collections/${row.id}`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/data',
          type: 'application/json',
          title: 'Feature collection',
        },
        {
          href: `${base}/api/public/ogc/collections/${row.id}/items`,
          rel: 'items',
          type: 'application/geo+json',
          title: 'Features (GeoJSON)',
        },
        {
          href: `${base}/api/public/ogc/collections/${row.id}/tiles/WebMercatorQuad`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector',
          type: 'application/json',
          title: 'Vector tileset',
        },
        {
          href: `${base}/api/public/ogc/styles/${row.id}`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/styles',
          type: 'application/vnd.mapbox.style+json',
          title: 'Default MapLibre style',
        },
      );
      break;
    case 'map':
    case 'web_app':
      // Web map / web app preview URLs live on portal-web, not on
      // the OGC surface. The `alternate` link above already points
      // at the portal item; downstream consumers walk that to find
      // the human-facing view.
      break;
    default:
      break;
  }

  const bboxArr = parseBbox(row.bbox);
  const geometry = bboxArr ? bboxToGeometry(bboxArr) : null;

  return {
    id: row.id,
    type: 'Record',
    conformsTo: [
      'http://www.opengis.net/spec/ogcapi-records-1/1.0/req/record-core',
    ],
    time: {
      // OGC Records uses ISO interval / instant; we expose the
      // item's lifecycle as the record validity window. End is
      // open ("..") for live records.
      interval: [row.createdAt.toISOString(), '..'],
      resolution: 'P1S',
    },
    properties: {
      title: row.title,
      description: row.description || row.title,
      created: row.createdAt.toISOString(),
      updated: row.updatedAt.toISOString(),
      type: row.type,
      keywords: row.tags ?? [],
      ...(row.license ? { license: row.license } : {}),
      // OGC Records §6: providers + themes are encouraged but
      // omitted here -- we don't yet curate a theme taxonomy and
      // a single-provider catalog adds noise without value.
      // formats: surface the encodings clients can reach.
      ...(row.type === 'data_layer'
        ? {
            formats: [
              { name: 'GeoJSON' },
              { name: 'MapboxVectorTile' },
            ],
          }
        : {}),
    },
    ...(geometry ? { geometry } : { geometry: null }),
    links,
  };
}

function parseBbox(b: unknown): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const arr = b as unknown[];
  if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  return arr as [number, number, number, number];
}

function bboxToGeometry(
  b: [number, number, number, number],
): Record<string, unknown> {
  const [w, s, e, n] = b;
  // Degenerate bbox (point or line) -> emit a Point at the
  // collapsed corner so downstream clients don't choke on a zero-
  // area polygon. Bbox arithmetic uses small epsilon to avoid
  // hairline cases on parcels stored at high precision.
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

/**
 * Parse the OGC Sortby query (`?sortby=key[,-key2]`) into a Prisma
 * orderBy array. Whitelisted columns only -- arbitrary JSON-path
 * sorts would need a Prisma raw query, which #116 doesn't ask for.
 */
function parseSortby(
  value: string | undefined,
): Array<Record<string, 'asc' | 'desc'>> {
  if (!value) return [{ updatedAt: 'desc' }];
  const allowed = new Set([
    'createdAt',
    'updatedAt',
    'title',
    'type',
  ]);
  const out: Array<Record<string, 'asc' | 'desc'>> = [];
  for (const raw of value.split(',')) {
    const s = raw.trim();
    if (s.length === 0) continue;
    let dir: 'asc' | 'desc' = 'asc';
    let key = s;
    if (s.startsWith('-')) {
      dir = 'desc';
      key = s.slice(1);
    } else if (s.startsWith('+')) {
      key = s.slice(1);
    }
    if (allowed.has(key)) out.push({ [key]: dir });
  }
  return out.length > 0 ? out : [{ updatedAt: 'desc' }];
}

function pagedUrl(
  selfBase: string,
  limit: number,
  offset: number,
  q: string | undefined,
  type: string | undefined,
  sortby: string | undefined,
): string {
  const url = new URL(selfBase);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (q) url.searchParams.set('q', q);
  if (type) url.searchParams.set('type', type);
  if (sortby) url.searchParams.set('sortby', sortby);
  return url.toString();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
