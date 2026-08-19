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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
} from '../public/stac/stac-core.js';
import {
  passthroughQuery,
  requireRasterCollection,
  stacLandingLinks,
  stacOpenApi,
} from '../public/stac/stac.controller.js';
import { rejectUnknownParams } from '../public/ogc/features-core.js';
import { absoluteBase } from '../public/ogc/url.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * STAC API for AUTHENTICATED callers: every tile_layer the caller can
 * read, not just the public tier (#29). The anonymous mirror lives at
 * /api/public/stac; the projection and search logic are shared
 * through stac-core so the two surfaces cannot drift on anything that
 * is not authorization.
 *
 * Authorization is the portal's one true pipeline, same as the authed
 * Features surface beside this file: listing filters with
 * SharingService.visibleWhere (the exact predicate the items list
 * uses), and single-item reads re-apply it in the WHERE rather than
 * fetching then checking, so an item the caller must not learn exists
 * answers 404.
 *
 * Asset and tile hrefs point at the shared tile-layer endpoints,
 * which enforce per-item ACL themselves; QGIS attaches its authcfg
 * (the portal API key) to those requests the same way it does for
 * XYZ layers today.
 *
 * Known wart, documented rather than hidden: a READ-ONLY API key is
 * refused on any method outside GET/HEAD/OPTIONS, so POST /search
 * answers 403 for it. GET /search is the full equivalent and is what
 * QGIS uses; a future @ReadSafe() route marker on the key path is the
 * right fix if a client that insists on POST shows up.
 */
@ApiTags('ogc', 'stac')
@ApiBearerAuth()
@Controller('stac')
@UseGuards(JwtAuthGuard)
export class AuthedStacController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  private rows(user: AuthUser): Promise<StacItemRow[]> {
    return this.prisma.item.findMany({
      where: {
        AND: [{ type: 'tile_layer' }, this.sharing.visibleWhere(user)],
      },
      select: STAC_ITEM_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Get('/')
  landing(@Req() req: Request) {
    const root = `${absoluteBase(req)}/api/stac`;
    return {
      type: 'Catalog',
      stac_version: STAC_VERSION,
      id: 'gratisgis',
      title: 'GratisGIS STAC API (signed in)',
      description:
        'SpatioTemporal Asset Catalog over every raster layer you can ' +
        'see. The anonymous mirror at /api/public/stac serves public ' +
        'items only. Read-only API keys must use GET /search; POST is ' +
        'refused for them as a non-GET method.',
      conformsTo: STAC_CONFORMANCE,
      links: stacLandingLinks(root),
    };
  }

  @Get('conformance')
  conformance() {
    return { conformsTo: STAC_CONFORMANCE };
  }

  @Get('api')
  @Header('Content-Type', 'application/vnd.oai.openapi+json;version=3.0')
  openApi(@Req() req: Request) {
    return stacOpenApi(`${absoluteBase(req)}/api/stac`);
  }

  @Get('collections')
  async collections(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const root = `${absoluteBase(req)}/api/stac`;
    const rows = await this.rows(user);
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

  @Get('collections/:collectionId')
  async collection(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
  ) {
    requireRasterCollection(collectionId);
    const root = `${absoluteBase(req)}/api/stac`;
    return buildRasterCollection(await this.rows(user), root);
  }

  @Get('collections/:collectionId/items')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async items(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
  ) {
    requireRasterCollection(collectionId);
    rejectUnknownParams(Object.keys(req.query), ITEMS_PARAM_NAMES);
    const params = parseSearchParams(req.query as Record<string, unknown>);
    const base = absoluteBase(req);
    const root = `${base}/api/stac`;
    return buildItemCollection({
      rows: await this.rows(user),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/collections/${RASTER_COLLECTION_ID}/items`,
      extraQuery: passthroughQuery(req.query, ITEMS_PARAM_NAMES),
    });
  }

  @Get('collections/:collectionId/items/:itemId')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async item(
    @CurrentUser() user: AuthUser,
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
        AND: [
          { id: itemId, type: 'tile_layer' },
          this.sharing.visibleWhere(user),
        ],
      },
      select: STAC_ITEM_SELECT,
    });
    if (!row) throw new NotFoundException('Item not found.');
    const base = absoluteBase(req);
    return buildStacItem(row, base, `${base}/api/stac`);
  }

  @Get('search')
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async searchGet(@CurrentUser() user: AuthUser, @Req() req: Request) {
    rejectUnknownParams(Object.keys(req.query), SEARCH_PARAM_NAMES);
    const params = parseSearchParams(req.query as Record<string, unknown>);
    const base = absoluteBase(req);
    const root = `${base}/api/stac`;
    return buildItemCollection({
      rows: await this.rows(user),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/search`,
      extraQuery: passthroughQuery(req.query, SEARCH_PARAM_NAMES),
    });
  }

  @Post('search')
  @HttpCode(200)
  @Header('Content-Type', STAC_GEOJSON_MEDIA_TYPE)
  async searchPost(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    rejectUnknownMembers(body ?? {}, SEARCH_PARAM_NAMES);
    const params = parseSearchParams(body ?? {});
    const base = absoluteBase(req);
    const root = `${base}/api/stac`;
    return buildItemCollection({
      rows: await this.rows(user),
      params,
      base,
      apiRoot: root,
      selfUrl: `${root}/search`,
    });
  }
}
