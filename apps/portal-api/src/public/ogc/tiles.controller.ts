// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DataLayerFeaturesService } from '../../data-layer/features.service.js';
import {
  TileCacheOverloadError,
  matchesIfNoneMatch,
  tileOverloadRetryAfterSeconds,
} from '../../engine/tile-cache.service.js';
import { absoluteBase } from './url.js';
import { parseCollectionId, formatCollectionId } from './collection-id.js';
import {
  PUBLIC_TIER_SELECT,
  publicTierGeoLimit,
} from '../public-geo-limit.js';

/**
 * OGC API - Tiles Part 1 Core for the publicly-shared data layers.
 *
 * Tileset ids reuse the collection-id scheme. WebMercatorQuad is
 * the only TileMatrixSet advertised; that matches the rest of the
 * portal's web-map pipeline (basemaps, runtime canvas, print
 * snapshots all run in EPSG:3857). Coverage / multi-CRS tile
 * matrix sets are out of scope for v1 per
 * `docs/ogc-api-strategy.md`.
 *
 * The actual tile bytes route through DataLayerFeaturesService.
 * mvtTile -- same engine path the authed `/items/:id/layers/...
 * /tile/...` endpoint uses. The OGC-side controller adds the
 * public-only ACL (item.access === 'public') and the OGC URL
 * shape; the engine handles the SQL.
 */
@ApiTags('public', 'ogc', 'tiles')
@Controller('public/ogc')
export class OgcTilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly v3: DataLayerFeaturesService,
  ) {}

  /** Registry of advertised TileMatrixSets. v1 is WebMercatorQuad
   *  only; future CRSes append here without changing the route
   *  shape. */
  @Public()
  @Get('tileMatrixSets')
  tileMatrixSets(@Req() req: Request) {
    const base = absoluteBase(req);
    return {
      links: [
        {
          href: `${base}/api/public/ogc/tileMatrixSets`,
          rel: 'self',
          type: 'application/json',
        },
      ],
      tileMatrixSets: [
        {
          id: 'WebMercatorQuad',
          title: 'Web Mercator Quad',
          uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
          crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
          links: [
            {
              href: `${base}/api/public/ogc/tileMatrixSets/WebMercatorQuad`,
              rel: 'self',
              type: 'application/json',
            },
          ],
        },
      ],
    };
  }

  @Public()
  @Get('tileMatrixSets/:tmsId')
  tileMatrixSet(@Param('tmsId') tmsId: string) {
    if (tmsId !== 'WebMercatorQuad') {
      throw new NotFoundException('TileMatrixSet not found.');
    }
    // The canonical WebMercatorQuad definition is large (26 zoom
    // levels each with origin / matrix dimensions). The spec
    // accepts referencing the published URI without echoing every
    // field, and most clients (QGIS, OpenLayers, MapLibre) resolve
    // WebMercatorQuad by name. Emit a compact form with the URI
    // and the well-known origin / extent; if a client needs the
    // full level table we can serve it from a constant later.
    return {
      id: 'WebMercatorQuad',
      title: 'Web Mercator Quad',
      uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
      crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      orderedAxes: ['X', 'Y'],
      wellKnownScaleSet:
        'http://www.opengis.net/def/wkss/OGC/1.0/GoogleMapsCompatible',
      // Standard EPSG:3857 world bounds in meters.
      boundingBox: {
        lowerLeft: [-20037508.342789244, -20037508.342789244],
        upperRight: [20037508.342789244, 20037508.342789244],
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      },
      tileMatrices: buildWebMercatorQuadMatrices(),
    };
  }

  /**
   * Tileset metadata for a collection at WebMercatorQuad. Returns
   * the per-tileset doc with the URL template the client uses to
   * fetch actual tiles. OGC Tiles Part 1 §10.
   */
  @Public()
  @Get('collections/:collectionId/tiles/:tmsId')
  async tileset(
    @Req() req: Request,
    @Param('collectionId') collectionId: string,
    @Param('tmsId') tmsId: string,
  ) {
    if (tmsId !== 'WebMercatorQuad') {
      throw new NotFoundException('TileMatrixSet not found for this tileset.');
    }
    const row = await this.resolvePublicTileset(collectionId);
    if (!row) throw new NotFoundException('Tileset not found.');
    const base = absoluteBase(req);
    const tileBase = `${base}/api/public/ogc/collections/${collectionId}/tiles/${tmsId}`;
    return {
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      // Data type: 'vector' for MVT, 'map' for raster image tiles.
      // We only emit vector tiles today.
      dataType: 'vector',
      crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      tileMatrixSetURI:
        'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
      links: [
        { href: `${tileBase}`, rel: 'self', type: 'application/json' },
        {
          href: `${base}/api/public/ogc/tileMatrixSets/${tmsId}`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme',
          type: 'application/json',
        },
        {
          href: `${base}/api/public/ogc/collections/${collectionId}`,
          rel: 'collection',
          type: 'application/json',
        },
        {
          // The URL template clients substitute into. {tileMatrix}
          // is the OGC name for the zoom band; {tileRow}/{tileCol}
          // are y/x. We expose the same shape as the route.
          href: `${tileBase}/{tileMatrix}/{tileRow}/{tileCol}`,
          rel: 'item',
          type: 'application/vnd.mapbox-vector-tile',
          templated: true,
        },
      ],
      vectorLayers: row.geometryType
        ? [
            {
              id: row.layerId,
              fields: row.fieldSchema,
              geometryType: row.geometryType,
              minzoom: 0,
              maxzoom: 22,
            },
          ]
        : [],
    };
  }

  /**
   * MVT tile bytes. The OGC URL shape uses {tileMatrix}/{tileRow}/
   * {tileCol} where row=Y, col=X. Internal call to mvtTile uses
   * (z,x,y); we swap accordingly.
   */
  @Public()
  @Get(
    'collections/:collectionId/tiles/:tmsId/:tileMatrix/:tileRow/:tileCol',
  )
  async tile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('collectionId') collectionId: string,
    @Param('tmsId') tmsId: string,
    @Param('tileMatrix') zStr: string,
    @Param('tileRow') yStr: string,
    @Param('tileCol') xStr: string,
  ) {
    if (tmsId !== 'WebMercatorQuad') {
      throw new NotFoundException('TileMatrixSet not found for this tileset.');
    }
    const row = await this.resolvePublicTileset(collectionId);
    if (!row) throw new NotFoundException('Tileset not found.');

    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z < 0 ||
      z > 24 ||
      x < 0 ||
      y < 0
    ) {
      throw new BadRequestException(
        'Invalid tile coordinates. Expect non-negative integers; z <= 24.',
      );
    }

    // Tier clip (#80). optsFingerprint() hashes geoLimit into the
    // tile cache key, so a clipped tile cannot be served from the
    // unclipped slot or vice versa.
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      row.publicGeoBoundaryId,
    );

    let mvt: Buffer;
    let etag: string;
    try {
      ({ mvt, etag } = await this.v3.mvtTile(
        row.itemId,
        row.layerId,
        z,
        x,
        y,
        {
          ...(row.fieldSchema.length > 0
            ? { fields: row.fieldSchema.map((f) => ({ name: f.name, type: f.type })) }
            : {}),
          ...(tierClip ? { geoLimit: tierClip } : {}),
        },
      ));
    } catch (e) {
      if (e instanceof TileCacheOverloadError) {
        res.setHeader('Retry-After', String(tileOverloadRetryAfterSeconds()));
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).end();
        return;
      }
      throw e;
    }
    // If-None-Match revalidation -- a downstream caching client
    // (QGIS, an aggregator) can ask "still the same tile?" and we
    // answer with 304 + no body, saving the transfer.
    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
    res.setHeader('ETag', etag);
    // Public tiles are pure functions of (collection, z, x, y) +
    // the layer's current state. The internal /tile/.mvt route uses
    // a 60s private cache window; we use a longer 5-minute public
    // window since the OGC consumer is more likely a downstream
    // caching client (QGIS, an aggregator) where the cache hit
    // matters more than write-recency for anonymous data.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(mvt);
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private async resolvePublicTileset(
    collectionId: string,
  ): Promise<TilesetRow | null> {
    const parsed = parseCollectionId(collectionId);
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
        data: true,
        ...PUBLIC_TIER_SELECT,
      },
    });
    if (!item) return null;
    const layers = pickV3Layers(item.data);
    if (layers.length === 0) return null;
    let target: V3LayerLite;
    if (parsed.layerKey === null) {
      target = layers[0]!;
    } else {
      const match = layers.find((l) => l.id === parsed.layerKey);
      if (!match) return null;
      target = match;
    }
    return {
      tilesetId: collectionId,
      itemId: item.id,
      layerId: target.id,
      geometryType: target.geometryType,
      title:
        layers.length > 1
          ? `${item.title} / ${target.label}`
          : item.title,
      description: item.description,
      fieldSchema: target.fields,
      publicGeoBoundaryId: item.publicGeoBoundaryId ?? null,
    };
  }
}

interface TilesetRow {
  tilesetId: string;
  itemId: string;
  layerId: string;
  geometryType: V3LayerLite['geometryType'];
  title: string;
  description: string;
  fieldSchema: V3LayerLite['fields'];
  /** #80 tier boundary; the OGC tile feed clips by it like every
   *  other public mirror. */
  publicGeoBoundaryId: string | null;
}

interface V3LayerLite {
  id: string;
  label: string;
  geometryType: string | null;
  fields: Array<{ name: string; type: string }>;
}

function pickV3Layers(data: unknown): V3LayerLite[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as {
    version?: number;
    layers?: Array<{
      id?: unknown;
      label?: unknown;
      geometryType?: unknown;
      fields?: Array<{ name?: unknown; type?: unknown }>;
    }>;
  };
  if (d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: V3LayerLite[] = [];
  for (const l of d.layers) {
    const id = l?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const label = typeof l?.label === 'string' ? l.label : id;
    const geometryType =
      typeof l?.geometryType === 'string' ? l.geometryType : null;
    const fields: V3LayerLite['fields'] = [];
    if (Array.isArray(l?.fields)) {
      for (const f of l.fields) {
        if (
          f &&
          typeof f.name === 'string' &&
          f.name.length > 0 &&
          typeof f.type === 'string'
        ) {
          fields.push({ name: f.name, type: f.type });
        }
      }
    }
    out.push({ id, label, geometryType, fields });
  }
  return out;
}

// Suppress unused-formatCollectionId import warning; the export is
// here for symmetry with the rest of the OGC controllers even though
// only parse is used directly in this file.
void formatCollectionId;

/**
 * Build the WebMercatorQuad tile matrix table. 26 zoom levels (0
 * through 25), 256x256 tile size, origin at the upper-left corner
 * of the Web Mercator world extent. Values match the OGC published
 * standard so a client that resolves WebMercatorQuad by name vs.
 * by inline definition gets the same result.
 *
 * Scale denominators are at the 0.28mm-pixel reference; multiplied
 * by `cellSize` (meters per pixel at zoom 0 / 2^z) and the global
 * pixel-density constant the OGC standard fixes at 559082264.0287
 * for zoom 0.
 */
function buildWebMercatorQuadMatrices(): Array<Record<string, unknown>> {
  const matrices: Array<Record<string, unknown>> = [];
  const Z0_SCALE_DENOM = 559082264.0287178;
  for (let z = 0; z <= 25; z += 1) {
    const tilesPerSide = 2 ** z;
    matrices.push({
      id: String(z),
      scaleDenominator: Z0_SCALE_DENOM / 2 ** z,
      cellSize: 156543.0339280410 / 2 ** z,
      cornerOfOrigin: 'topLeft',
      pointOfOrigin: [-20037508.342789244, 20037508.342789244],
      tileWidth: 256,
      tileHeight: 256,
      matrixWidth: tilesPerSide,
      matrixHeight: tilesPerSide,
    });
  }
  return matrices;
}
