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

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DataLayerFeaturesService } from '../../data-layer/features.service.js';
import { absoluteBase } from './url.js';
import { parseCollectionId } from './collection-id.js';
import {
  PUBLIC_TIER_SELECT,
  publicTierGeoLimit,
} from '../public-geo-limit.js';
import {
  buildItemsResponse,
  collectionDoc,
  expandCollectionRows,
  parseCrs,
  pickV3Layers,
  swapAxes,
  type CollectionRow,
} from './features-core.js';

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
 *   - `sortby` is rejected with 400 (see features-core, which owns
 *     the whole paging envelope and its hard-won history).
 *
 * Conformance URIs are declared in `landing.controller.ts`. Adding a
 * new class means appending the URI there, not editing this file.
 *
 * All endpoints are anonymous and only see items with
 * `access = 'public'` (mirrors `/catalog.json`). The AUTHENTICATED
 * mirror of this surface lives in `src/ogc/`; the spec-shaped logic
 * they share lives in `features-core.ts`.
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
      collections: rows.map((r) =>
        collectionDoc(r, `${base}/api/public/ogc`, { tilesAndStyles: true }),
      ),
    };
  }

  @Public()
  @Get(':id')
  async collection(@Req() req: Request, @Param('id') id: string) {
    const row = await this.resolvePublicCollection(id);
    if (!row) throw new NotFoundException('Collection not found.');
    return collectionDoc(row, `${absoluteBase(req)}/api/public/ogc`, {
      tilesAndStyles: true,
    });
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

    // #80 tier boundary: every read off a public row clips by it.
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      row.publicGeoBoundaryId,
    );

    const base = absoluteBase(req);
    return buildItemsResponse({
      query: {
        bboxParam, bboxCrsParam, crsParam,
        limitParam, offsetParam, sortbyParam,
      },
      itemsUrl: `${base}/api/public/ogc/collections/${id}/items`,
      collectionUrl: `${base}/api/public/ogc/collections/${id}`,
      listFeatures: (opts) =>
        this.v3.listFeatures(row.itemId, row.layerId, {
          ...opts,
          ...(tierClip ? { geoLimit: tierClip } : {}),
        }),
    });
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

    // Clip here too: without it, a caller who knows a feature id can
    // read a feature that sits outside the public tier boundary one
    // at a time, which defeats the clip on the collection listing.
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      row.publicGeoBoundaryId,
    );
    const fc = await this.v3.listFeatures(row.itemId, row.layerId, {
      entity: featureId,
      ...(tierClip ? { geoLimit: tierClip } : {}),
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
   * collectionId) rows via the shared expansion, then annotated with
   * each item's public tier boundary for the read-time clip.
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
        ...PUBLIC_TIER_SELECT,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const boundaries = new Map(
      rows.map((r) => [r.id, r.publicGeoBoundaryId ?? null]),
    );
    return expandCollectionRows(rows).map((row) => ({
      ...row,
      publicGeoBoundaryId: boundaries.get(row.itemId) ?? null,
    }));
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
        ...PUBLIC_TIER_SELECT,
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
      publicGeoBoundaryId: item.publicGeoBoundaryId ?? null,
    };
  }
}

interface DataLayerRow extends CollectionRow {
  /** #80 tier boundary. Every read off this row must clip by it; the
   *  OGC feed is a public mirror like any other. */
  publicGeoBoundaryId: string | null;
}
