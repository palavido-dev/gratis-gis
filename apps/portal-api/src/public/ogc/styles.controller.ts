// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { absoluteBase } from './url.js';
import { parseCollectionId, formatCollectionId } from './collection-id.js';

/**
 * OGC API - Styles Part 1 (Core) for the publicly-shared data
 * layers exposed by the Features controller. Style ids reuse the
 * collection-id scheme (bare UUID for single-layer items,
 * `<itemId>__<layerKey>` for multi-layer items) so a client that
 * already knows a collection id also knows the style id.
 *
 * For v1 the styles are GratisGIS-curated defaults derived from
 * each layer's geometry type (point -> circle, line -> line,
 * polygon -> fill + line) with a sensible palette. The portal's
 * Map-level renderer overrides aren't surfaced here yet: a
 * data_layer item doesn't carry its own paint config (that lives
 * on MapLayer references inside `map` items), and the
 * "first map that references this layer wins" heuristic creates
 * non-obvious dependencies between unrelated items. v1.1 follow-up
 * can promote curated-on-the-layer styles when authors have an
 * explicit picker.
 *
 * The MapLibre style document points its `data` source at the
 * Features endpoint for the same collection, so a tool that
 * applies the style automatically gets the matching data path.
 * Tiles (#113) will plug in here later by switching the source to
 * `vector` and pointing at the tileset.
 */
@ApiTags('public', 'ogc', 'styles')
@Controller('public/ogc/styles')
export class OgcStylesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('/')
  async styles(@Req() req: Request) {
    const base = absoluteBase(req);
    const rows = await this.publicV3LayersForStyles();
    return {
      links: [
        {
          href: `${base}/api/public/ogc/styles`,
          rel: 'self',
          type: 'application/json',
        },
        {
          href: `${base}/api/public/ogc/`,
          rel: 'root',
          type: 'application/json',
        },
      ],
      styles: rows.map((r) => ({
        id: r.styleId,
        title: r.title,
        ...(r.description ? { description: r.description } : {}),
        links: [
          {
            href: `${base}/api/public/ogc/styles/${r.styleId}`,
            rel: 'stylesheet',
            type: 'application/vnd.mapbox.style+json',
            title: 'MapLibre / Mapbox GL style',
          },
          {
            href: `${base}/api/public/ogc/styles/${r.styleId}/metadata`,
            rel: 'describedby',
            type: 'application/json',
          },
          {
            href: `${base}/api/public/ogc/collections/${r.styleId}`,
            rel: 'data',
            type: 'application/json',
            title: 'Feature collection this style applies to',
          },
        ],
      })),
    };
  }

  @Public()
  @Get(':styleId')
  // The styles list and the OpenAPI document have always advertised
  // this media type for the style document itself; serving plain
  // application/json made the surface disagree with its own links.
  @Header('Content-Type', 'application/vnd.mapbox.style+json')
  async style(@Req() req: Request, @Param('styleId') styleId: string) {
    const row = await this.resolveStyleTarget(styleId);
    if (!row) throw new NotFoundException('Style not found.');
    return buildMapLibreStyle(row, absoluteBase(req));
  }

  @Public()
  @Get(':styleId/metadata')
  async metadata(
    @Req() req: Request,
    @Param('styleId') styleId: string,
  ) {
    const row = await this.resolveStyleTarget(styleId);
    if (!row) throw new NotFoundException('Style not found.');
    const base = absoluteBase(req);
    return {
      id: row.styleId,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      keywords: row.tags ?? [],
      ...(row.license ? { license: row.license } : {}),
      // Styles Part 1 §6: every style metadata document should
      // identify the layer(s) it can be applied to.
      layers: [
        {
          id: row.styleId,
          type: geometryTypeToStyleType(row.geometryType),
          sampleData: {
            href: `${base}/api/public/ogc/collections/${row.styleId}/items?limit=10`,
            rel: 'sample',
            type: 'application/geo+json',
          },
        },
      ],
      links: [
        {
          href: `${base}/api/public/ogc/styles/${row.styleId}`,
          rel: 'stylesheet',
          type: 'application/vnd.mapbox.style+json',
        },
        {
          href: `${base}/api/public/ogc/styles/${row.styleId}/metadata`,
          rel: 'self',
          type: 'application/json',
        },
      ],
    };
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  /**
   * Flatten every public v3 data_layer into (style-id, geometry,
   * title) rows. Multi-layer items expose one style per layer
   * plus the bare-UUID alias for the first layer (mirrors
   * Features controller listing).
   */
  private async publicV3LayersForStyles(): Promise<StyleRow[]> {
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
        data: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const out: StyleRow[] = [];
    for (const r of rows) {
      const layers = pickV3Layers(r.data);
      if (layers.length === 0) continue;
      const first = layers[0]!;
      out.push({
        styleId: r.id,
        itemId: r.id,
        layerKey: null,
        geometryType: first.geometryType,
        title:
          layers.length > 1 ? `${r.title} / ${first.label}` : r.title,
        description: r.description,
        tags: r.tags,
        license: r.license,
      });
      if (layers.length > 1) {
        for (const lyr of layers) {
          out.push({
            styleId: formatCollectionId(r.id, lyr.id),
            itemId: r.id,
            layerKey: lyr.id,
            geometryType: lyr.geometryType,
            title: `${r.title} / ${lyr.label}`,
            description: r.description,
            tags: r.tags,
            license: r.license,
          });
        }
      }
    }
    return out;
  }

  private async resolveStyleTarget(
    styleId: string,
  ): Promise<StyleRow | null> {
    const parsed = parseCollectionId(styleId);
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
        data: true,
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
      styleId,
      itemId: item.id,
      layerKey: parsed.layerKey,
      geometryType: target.geometryType,
      title:
        layers.length > 1
          ? `${item.title} / ${target.label}`
          : item.title,
      description: item.description,
      tags: item.tags,
      license: item.license,
    };
  }
}

interface StyleRow {
  styleId: string;
  itemId: string;
  layerKey: string | null;
  geometryType: V3LayerLite['geometryType'];
  title: string;
  description: string;
  tags: string[];
  license: string | null;
}

interface V3LayerLite {
  id: string;
  label: string;
  geometryType:
    | 'Point'
    | 'MultiPoint'
    | 'LineString'
    | 'MultiLineString'
    | 'Polygon'
    | 'MultiPolygon'
    | null;
}

function pickV3Layers(data: unknown): V3LayerLite[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as {
    version?: number;
    layers?: Array<{
      id?: unknown;
      label?: unknown;
      geometryType?: unknown;
    }>;
  };
  if (d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: V3LayerLite[] = [];
  for (const l of d.layers) {
    const id = l?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const label = typeof l?.label === 'string' ? l.label : id;
    const gt = l?.geometryType;
    const geometryType: V3LayerLite['geometryType'] =
      gt === 'Point' ||
      gt === 'MultiPoint' ||
      gt === 'LineString' ||
      gt === 'MultiLineString' ||
      gt === 'Polygon' ||
      gt === 'MultiPolygon'
        ? gt
        : null;
    out.push({ id, label, geometryType });
  }
  return out;
}

function geometryTypeToStyleType(
  g: V3LayerLite['geometryType'],
): 'point' | 'line' | 'polygon' | 'table' {
  if (g === 'Point' || g === 'MultiPoint') return 'point';
  if (g === 'LineString' || g === 'MultiLineString') return 'line';
  if (g === 'Polygon' || g === 'MultiPolygon') return 'polygon';
  return 'table';
}

/**
 * Build a MapLibre v8 style document for the given style row. The
 * source points at the collection's Features endpoint so a tool
 * that loads the style picks up the matching data path
 * automatically. Per-geometry-type defaults are intentionally
 * simple (one fill + line for polygons, one line for lines, one
 * circle for points) -- the surface is a curated default, not the
 * full renderer-replication path. See class-level docstring for
 * the rationale.
 */
function buildMapLibreStyle(
  row: StyleRow,
  base: string,
): Record<string, unknown> {
  const sourceId = 'data';
  const dataUrl = `${base}/api/public/ogc/collections/${row.styleId}/items`;
  const sources = {
    [sourceId]: { type: 'geojson', data: dataUrl },
  };
  const layers: Array<Record<string, unknown>> = [];
  const accent = '#4f46e5'; // indigo-600, matches the portal accent
  const stroke = '#1e1b4b'; // indigo-950
  switch (geometryTypeToStyleType(row.geometryType)) {
    case 'polygon':
      layers.push(
        {
          id: `${row.styleId}-fill`,
          type: 'fill',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'fill-color': accent,
            'fill-opacity': 0.35,
          },
        },
        {
          id: `${row.styleId}-stroke`,
          type: 'line',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'line-color': stroke,
            'line-width': 1.5,
          },
        },
      );
      break;
    case 'line':
      layers.push({
        id: `${row.styleId}-line`,
        type: 'line',
        source: sourceId,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': accent,
          'line-width': 2,
        },
      });
      break;
    case 'point':
      layers.push({
        id: `${row.styleId}-point`,
        type: 'circle',
        source: sourceId,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': accent,
          'circle-stroke-color': stroke,
          'circle-stroke-width': 1,
        },
      });
      break;
    // attribute-only "table" layers don't emit any paint layers --
    // they're not renderable. The style still validates as MapLibre
    // (sources without referencing layers is allowed) so a client
    // doesn't 500 on fetch.
    case 'table':
      break;
  }
  return {
    version: 8,
    name: row.title,
    sources,
    layers,
    metadata: {
      'gratisgis:collectionId': row.styleId,
      'gratisgis:storageCrs': 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    },
  };
}
