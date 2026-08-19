// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { rejectUnknownParams } from '../ogc/features-core.js';
import { absoluteBase } from '../ogc/url.js';
import {
  ITEMS_PARAM_NAMES,
  RASTER_COLLECTION_ID,
  SEARCH_PARAM_NAMES,
  STAC_CONFORMANCE,
  STAC_GEOJSON_MEDIA_TYPE,
  STAC_ITEM_SELECT,
  STAC_VERSION,
  buildItemCollection,
  buildRasterCollection,
  buildStacItem,
  parseSearchParams,
  rejectUnknownMembers,
  type StacItemRow,
} from './stac-core.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Anonymous STAC API over publicly-shared tile_layer items (#29).
 *
 * QGIS 3.42+ ships a native STAC browser in the Data Source Manager,
 * so this surface puts the portal's public rasters into stock QGIS
 * with no plugin installed: browse the catalog, see footprints on the
 * canvas, filter by extent and time, and load the COG / tiles.
 *
 * Same posture as the rest of /api/public: public items only,
 * @Public() routes, and everything the caller could learn here they
 * could learn from the public item APIs already. The signed-in
 * mirror at /api/stac (authed-stac.controller.ts) serves every
 * raster the caller can see; the projection logic is shared through
 * stac-core so the two cannot drift.
 *
 * Caddy proxies all of /api/* straight to portal-api, so no BFF
 * anonymous-allowlist entry is involved for either surface.
 */
@ApiTags('public', 'stac')
@Controller('public/stac')
export class PublicStacController {
  constructor(private readonly prisma: PrismaService) {}

  private rows(): Promise<StacItemRow[]> {
    return this.prisma.item.findMany({
      where: { type: 'tile_layer', access: 'public', deletedAt: null },
      select: STAC_ITEM_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Public()
  @Get('/')
  landing(@Req() req: Request) {
    const base = absoluteBase(req);
    const root = `${base}/api/public/stac`;
    return {
      type: 'Catalog',
      stac_version: STAC_VERSION,
      id: 'gratisgis',
      title: 'GratisGIS STAC API',
      description:
        'SpatioTemporal Asset Catalog over the publicly-shared raster ' +
        'layers hosted by this GratisGIS portal. Signed-in users can ' +
        'reach every raster they can see at /api/stac with the same ' +
        'document shapes.',
      conformsTo: STAC_CONFORMANCE,
      links: stacLandingLinks(root),
    };
  }

  @Public()
  @Get('conformance')
  conformance() {
    return { conformsTo: STAC_CONFORMANCE };
  }

  @Public()
  @Get('api')
  @Header('Content-Type', 'application/vnd.oai.openapi+json;version=3.0')
  openApi(@Req() req: Request) {
    return stacOpenApi(`${absoluteBase(req)}/api/public/stac`);
  }

  @Public()
  @Get('collections')
  async collections(@Req() req: Request) {
    const root = `${absoluteBase(req)}/api/public/stac`;
    const rows = await this.rows();
    return {
      collections: [buildRasterCollection(rows, root)],
      links: [
        {
          href: `${root}/collections`,
          rel: 'self',
          type: 'application/json',
        },
        { href: `${root}/`, rel: 'root', type: 'application/json' },
      ],
    };
  }

  @Public()
  @Get('collections/:collectionId')
  async collection(
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
  ) {
    requireRasterCollection(collectionId);
    const root = `${absoluteBase(req)}/api/public/stac`;
    return buildRasterCollection(await this.rows(), root);
  }

  @Public()
  @Get('collections/:collectionId/items')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async items(
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
  ) {
    requireRasterCollection(collectionId);
    rejectUnknownParams(Object.keys(req.query), ITEMS_PARAM_NAMES);
    const params = parseSearchParams(
      req.query as Record<string, unknown>,
    );
    const base = absoluteBase(req);
    const root = `${base}/api/public/stac`;
    return buildItemCollection({
      rows: await this.rows(),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/collections/${RASTER_COLLECTION_ID}/items`,
      extraQuery: passthroughQuery(req.query, ITEMS_PARAM_NAMES),
    });
  }

  @Public()
  @Get('collections/:collectionId/items/:itemId')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async item(
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    requireRasterCollection(collectionId);
    if (!UUID_RE.test(itemId)) {
      throw new NotFoundException('Item not found.');
    }
    const row = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        type: 'tile_layer',
        access: 'public',
        deletedAt: null,
      },
      select: STAC_ITEM_SELECT,
    });
    if (!row) throw new NotFoundException('Item not found.');
    const base = absoluteBase(req);
    return buildStacItem(row, base, `${base}/api/public/stac`);
  }

  @Public()
  @Get('search')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async searchGet(@Req() req: Request) {
    rejectUnknownParams(Object.keys(req.query), SEARCH_PARAM_NAMES);
    const params = parseSearchParams(req.query as Record<string, unknown>);
    const base = absoluteBase(req);
    const root = `${base}/api/public/stac`;
    return buildItemCollection({
      rows: await this.rows(),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/search`,
      extraQuery: passthroughQuery(req.query, SEARCH_PARAM_NAMES),
    });
  }

  /**
   * POST body, same semantics. 200 on purpose: Nest defaults POST to
   * 201, which would claim a resource was created by a read.
   */
  @Public()
  @Post('search')
  @HttpCode(200)
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async searchPost(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    rejectUnknownMembers(body ?? {}, SEARCH_PARAM_NAMES);
    const params = parseSearchParams(body ?? {});
    const base = absoluteBase(req);
    const root = `${base}/api/public/stac`;
    return buildItemCollection({
      rows: await this.rows(),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/search`,
    });
  }
}

/** 404 for any collection id other than the one we serve. */
export function requireRasterCollection(id: string): void {
  if (id !== RASTER_COLLECTION_ID) {
    throw new NotFoundException('Collection not found.');
  }
}

/** Carry the filter parameters into next/prev links so a paged walk
 *  keeps its filters. limit/offset are set by the pager itself. */
export function passthroughQuery(
  query: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (key === 'limit' || key === 'offset') continue;
    const v = query[key];
    if (v !== undefined) out[key] = String(v);
  }
  return out;
}

/** The landing link set, shared with the authed mirror. */
export function stacLandingLinks(
  root: string,
): Array<Record<string, unknown>> {
  return [
    { href: `${root}/`, rel: 'self', type: 'application/json' },
    { href: `${root}/`, rel: 'root', type: 'application/json' },
    {
      href: `${root}/conformance`,
      rel: 'conformance',
      type: 'application/json',
    },
    {
      href: `${root}/api`,
      rel: 'service-desc',
      type: 'application/vnd.oai.openapi+json;version=3.0',
      title: 'OpenAPI 3.0 description',
    },
    {
      href: `${root}/collections`,
      rel: 'data',
      type: 'application/json',
      title: 'Collections',
    },
    {
      href: `${root}/collections/${RASTER_COLLECTION_ID}`,
      rel: 'child',
      type: 'application/json',
      title: 'Raster layers',
    },
    {
      href: `${root}/search`,
      rel: 'search',
      type: STAC_GEOJSON_MEDIA_TYPE,
      method: 'GET',
      title: 'Item search (GET)',
    },
    {
      href: `${root}/search`,
      rel: 'search',
      type: STAC_GEOJSON_MEDIA_TYPE,
      method: 'POST',
      title: 'Item search (POST)',
    },
  ];
}

/**
 * Minimal OpenAPI description of the STAC surface, shared by both
 * mirrors (the servers entry differs). Hand-rolled for the same
 * reason as the OGC one: the shape is the contract, not decoration.
 */
export function stacOpenApi(root: string): Record<string, unknown> {
  const searchParams = [
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    },
    {
      name: 'offset',
      in: 'query',
      schema: { type: 'integer', minimum: 0, default: 0 },
    },
    {
      name: 'bbox',
      in: 'query',
      schema: { type: 'string' },
      description: 'west,south,east,north (or 6 numbers; z is dropped).',
    },
    {
      name: 'datetime',
      in: 'query',
      schema: { type: 'string' },
      description:
        'RFC 3339 instant, or interval "start/end" where either side ' +
        'may be "..". Matches against the item upload time.',
    },
  ];
  const searchOnlyParams = [
    {
      name: 'ids',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated item ids.',
    },
    {
      name: 'collections',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated collection ids.',
    },
    {
      name: 'intersects',
      in: 'query',
      schema: { type: 'string' },
      description:
        'JSON-encoded GeoJSON geometry. Cannot be combined with bbox.',
    },
  ];
  return {
    openapi: '3.0.3',
    info: {
      title: 'GratisGIS STAC API',
      description:
        'SpatioTemporal Asset Catalog over the raster layers hosted ' +
        'by this GratisGIS portal.',
      version: '1.0.0',
      license: {
        name: 'AGPL-3.0-or-later',
        url: 'https://www.gnu.org/licenses/agpl-3.0.html',
      },
    },
    servers: [{ url: root }],
    paths: {
      '/': {
        get: {
          summary: 'Landing page (STAC Catalog)',
          responses: { '200': { description: 'Catalog document' } },
        },
      },
      '/conformance': {
        get: {
          summary: 'Conformance declaration',
          responses: { '200': { description: 'Conformance list' } },
        },
      },
      '/api': {
        get: {
          summary: 'OpenAPI 3.0 document',
          responses: { '200': { description: 'This document' } },
        },
      },
      '/collections': {
        get: {
          summary: 'Collections list',
          responses: { '200': { description: 'Collections document' } },
        },
      },
      '/collections/{collectionId}': {
        get: {
          summary: 'Collection metadata',
          parameters: [
            {
              name: 'collectionId',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: [RASTER_COLLECTION_ID] },
            },
          ],
          responses: {
            '200': { description: 'Collection document' },
            '404': { description: 'Collection not found' },
          },
        },
      },
      '/collections/{collectionId}/items': {
        get: {
          summary: 'Items in the collection (ItemCollection)',
          parameters: [
            {
              name: 'collectionId',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: [RASTER_COLLECTION_ID] },
            },
            ...searchParams,
          ],
          responses: {
            '200': { description: 'GeoJSON ItemCollection' },
            '400': {
              description:
                'Invalid parameter value, or a parameter not in this ' +
                'API definition',
            },
            '404': { description: 'Collection not found' },
          },
        },
      },
      '/collections/{collectionId}/items/{itemId}': {
        get: {
          summary: 'One STAC Item',
          parameters: [
            {
              name: 'collectionId',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: [RASTER_COLLECTION_ID] },
            },
            {
              name: 'itemId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'GeoJSON Feature (STAC Item)' },
            '404': { description: 'Item or collection not found' },
          },
        },
      },
      '/search': {
        get: {
          summary: 'Item search',
          parameters: [...searchParams, ...searchOnlyParams],
          responses: {
            '200': { description: 'GeoJSON ItemCollection' },
            '400': { description: 'Invalid or unknown parameter' },
          },
        },
        post: {
          summary: 'Item search (JSON body, same semantics)',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                    bbox: { type: 'array', items: { type: 'number' } },
                    datetime: { type: 'string' },
                    ids: { type: 'array', items: { type: 'string' } },
                    collections: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    intersects: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'GeoJSON ItemCollection' },
            '400': { description: 'Invalid or unknown member' },
          },
        },
      },
    },
  };
}
