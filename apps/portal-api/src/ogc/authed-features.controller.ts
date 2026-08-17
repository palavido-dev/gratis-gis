// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseCollectionId } from '../public/ogc/collection-id.js';
import {
  buildItemsResponse,
  collectionDoc,
  expandCollectionRows,
  parseCrs,
  pickV3Layers,
  swapAxes,
  type CollectionRow,
} from '../public/ogc/features-core.js';
import { absoluteBase } from '../public/ogc/url.js';

/**
 * OGC API Features for AUTHENTICATED callers: every data_layer the
 * caller can read, not just the public tier.
 *
 * Why this exists: the public surface under /api/public/ogc is the
 * only Features endpoint the portal had, so a private layer could be
 * drawn in QGIS (vector tiles, MVT, authed) but never opened as a
 * TRUE feature layer with an attribute table. This surface closes
 * that: QGIS's OGC API Features provider speaks it with an authcfg
 * attached, and the read-only layer API key minted at sign-in is
 * exactly the right credential (GET-only, item-scoped by sharing).
 *
 * Authorization is the portal's one true pipeline, not a copy:
 *   - Collection listing filters with SharingService.visibleWhere,
 *     the same predicate the items list uses, so the two can never
 *     disagree about what a caller sees.
 *   - Per-collection reads resolve through ItemsService.get, which
 *     applies canRead and answers 404 (not 403) for items the caller
 *     must not learn exist.
 *   - Every feature read applies the caller's share geo limit and
 *     row scope, mirroring assertV3Layer in
 *     data-layer/features.controller.ts (the /geojson path). If that
 *     helper's rules change, this resolver must change with it; the
 *     spec pins the clips reaching the engine.
 *
 * The spec-shaped envelope (paging, CRS, bbox, links) is shared with
 * the public controller via features-core, so the two surfaces answer
 * identically for everything that is not authorization.
 */
@ApiTags('ogc', 'features')
@ApiBearerAuth()
@Controller('ogc')
@UseGuards(JwtAuthGuard)
export class AuthedOgcFeaturesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemsService: ItemsService,
    private readonly sharing: SharingService,
    private readonly v3: DataLayerFeaturesService,
  ) {}

  /**
   * Landing page. QGIS's provider walks self -> conformance ->
   * collections from here; the links are the API.
   */
  @Get('/')
  landing(@Req() req: Request) {
    const root = `${absoluteBase(req)}/api/ogc`;
    return {
      title: 'GratisGIS OGC API (signed in)',
      description:
        'OGC API Features over every data layer you can read. The ' +
        'anonymous mirror at /api/public/ogc serves public items only.',
      links: [
        { href: `${root}/`, rel: 'self', type: 'application/json' },
        {
          href: `${root}/conformance`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/conformance',
          type: 'application/json',
        },
        {
          href: `${root}/collections`,
          rel: 'data',
          type: 'application/json',
        },
      ],
    };
  }

  /**
   * Features-only conformance. No Tiles / Styles / Records classes
   * here: those remain public-surface citizens for now, and QGIS
   * only needs Core + GeoJSON + CRS to open collections.
   */
  @Get('conformance')
  conformance() {
    return {
      conformsTo: [
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page',
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
        'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs',
      ],
    };
  }

  @Get('collections')
  async collections(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const base = absoluteBase(req);
    const rows = await this.prisma.item.findMany({
      where: {
        AND: [{ type: 'data_layer' }, this.sharing.visibleWhere(user)],
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
    return {
      links: [
        {
          href: `${base}/api/ogc/collections`,
          rel: 'self',
          type: 'application/json',
        },
        { href: `${base}/api/ogc/`, rel: 'root', type: 'application/json' },
        {
          href: `${base}/api/ogc/conformance`,
          rel: 'conformance',
          type: 'application/json',
        },
      ],
      collections: expandCollectionRows(rows).map((r) =>
        collectionDoc(r, `${base}/api/ogc`),
      ),
    };
  }

  @Get('collections/:id')
  async collection(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const resolved = await this.resolveCollection(user, id);
    return collectionDoc(resolved.row, `${absoluteBase(req)}/api/ogc`);
  }

  @Get('collections/:id/items')
  async items(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Query('bbox') bboxParam?: string,
    @Query('bbox-crs') bboxCrsParam?: string,
    @Query('crs') crsParam?: string,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('sortby') sortbyParam?: string,
  ) {
    const resolved = await this.resolveCollection(user, id);
    const base = absoluteBase(req);
    return buildItemsResponse({
      query: {
        bboxParam, bboxCrsParam, crsParam,
        limitParam, offsetParam, sortbyParam,
      },
      itemsUrl: `${base}/api/ogc/collections/${id}/items`,
      collectionUrl: `${base}/api/ogc/collections/${id}`,
      listFeatures: (opts) =>
        this.v3.listFeatures(resolved.row.itemId, resolved.row.layerId, {
          ...opts,
          ...resolved.clips,
        }),
    });
  }

  @Get('collections/:id/items/:featureId')
  async feature(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('featureId') featureId: string,
    @Query('crs') crsParam?: string,
  ) {
    const resolved = await this.resolveCollection(user, id);
    const crs = parseCrs(crsParam);
    // The clips apply to single-feature reads too, or a caller who
    // knows an id could walk features outside their share geo limit
    // one at a time. Same rule as the public tier clip.
    const fc = await this.v3.listFeatures(
      resolved.row.itemId,
      resolved.row.layerId,
      { entity: featureId, ...resolved.clips },
    );
    const found = fc.features[0];
    if (!found) throw new NotFoundException('Feature not found.');
    const out = crs === 'epsg-4326' ? swapAxes(found) : found;
    const base = absoluteBase(req);
    return {
      ...out,
      links: [
        {
          href: `${base}/api/ogc/collections/${id}/items/${featureId}`,
          rel: 'self',
          type: 'application/geo+json',
        },
        {
          href: `${base}/api/ogc/collections/${id}`,
          rel: 'collection',
          type: 'application/json',
        },
      ],
    };
  }

  // -----------------------------------------------------------
  // Resolution: one ACL'd read producing the row AND its clips
  // -----------------------------------------------------------

  private async resolveCollection(
    user: AuthUser,
    id: string,
  ): Promise<{
    row: CollectionRow;
    clips: {
      geoLimit?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
    };
  }> {
    const parsed = parseCollectionId(id);
    if (!parsed) throw new NotFoundException('Collection not found.');
    // ItemsService.get applies canRead and answers 404 for items the
    // caller must not learn exist; both behaviors are wanted here
    // verbatim, so the NotFoundException passes through untouched.
    const item = await this.itemsService.get(user, parsed.itemId);
    if (item.type !== 'data_layer') {
      throw new NotFoundException('Collection not found.');
    }
    const layers = pickV3Layers(item.data);
    if (layers.length === 0) {
      throw new NotFoundException('Collection not found.');
    }
    const layer =
      parsed.layerKey === null
        ? layers[0]!
        : layers.find((l) => l.id === parsed.layerKey);
    if (!layer) throw new NotFoundException('Collection not found.');

    // The caller's clips, mirroring assertV3Layer('read') in
    // data-layer/features.controller.ts: share geo limits narrow the
    // SELECT to the shared polygon, row scope narrows to rows the
    // caller created, and both are bypassed for owner / org admin /
    // public inside SharingService. Skipping either here would make
    // this surface see MORE than the portal's own reads.
    const shares = (item as { shares?: ItemShare[] }).shares ?? [];
    const geoLimit = await this.sharing.geoLimitFor(user, item, shares);
    const rowScope = this.sharing.effectiveRowScope(
      user,
      item,
      shares,
      layer.editingPolicy ?? 'all-rows',
      'read',
    );
    const isTable = layer.geometryType === null;
    const clips: {
      geoLimit?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
    } = {};
    if (geoLimit) clips.geoLimit = geoLimit;
    if (rowScope === 'own') clips.ownRowsOnly = { userId: user.id };
    if (isTable) clips.isTable = true;

    const label = layer.label ?? layer.id;
    return {
      row: {
        collectionId: id,
        itemId: item.id,
        layerId: layer.id,
        title: layers.length > 1 ? `${item.title} / ${label}` : item.title,
        description: item.description ?? '',
        tags: item.tags ?? [],
        license: item.license ?? null,
        updatedAt: item.updatedAt,
      },
      clips,
    };
  }
}
