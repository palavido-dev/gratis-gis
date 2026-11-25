// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { Public } from '../auth/public.decorator.js';
import { fieldDoc } from './esri-fields.js';
import {
  CURRENT_VERSION,
  extentDoc,
  infoDoc,
  layerDoc,
  serviceDoc,
  WGS84,
} from './esri-docs.js';
import { EsriErrorFilter } from './esri-error.filter.js';
import { parseEsriQuery, srDoc, type RawParams } from './esri-query-params.js';
import { FeatureServerAccessService, type ResolvedService, type StoredLayer } from './featureserver-access.service.js';
import { FeatureServerQueryService, type Extent } from './featureserver-query.service.js';

function callerOf(req: Request): AuthUser | null {
  return ((req as Request & { user?: AuthUser | null }).user ?? null) as AuthUser | null;
}

function layerName(l: StoredLayer): string {
  return (typeof l.label === 'string' && l.label.trim()) || (typeof l.name === 'string' && l.name.trim()) || l.id;
}

function storedBbox(l: StoredLayer): Extent | null {
  const b = l.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  return { xmin: b[0] as number, ymin: b[1] as number, xmax: b[2] as number, ymax: b[3] as number };
}

/**
 * The Esri FeatureServer (GeoServices REST) interface, read side, so
 * ArcGIS Pro and QGIS can add a data layer as a feature layer:
 *
 *   /api/arcgis/rest/info
 *   /api/arcgis/rest/services
 *   /api/arcgis/rest/services/<name>/FeatureServer
 *   /api/arcgis/rest/services/<name>/FeatureServer/layers
 *   /api/arcgis/rest/services/<name>/FeatureServer/<n>
 *   /api/arcgis/rest/services/<name>/FeatureServer/<n>/query
 *
 * One item is one service; each sublayer or table is one layer, with a
 * number that never changes. Clients find /rest/info by cutting the
 * URL at /rest/, so the interface can live under /api like the rest
 * of the API. Signed-in callers use a personal API key for now; Esri
 * sign-in (generateToken) and edits come in the next part.
 */
@ApiTags('featureserver')
@Controller('arcgis/rest')
@UseFilters(EsriErrorFilter)
export class FeatureServerController {
  constructor(
    private readonly access: FeatureServerAccessService,
    private readonly query: FeatureServerQueryService,
  ) {}

  @Public()
  @Get('info')
  info() {
    return infoDoc();
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('services')
  async services(@Req() req: Request, @Query('org') org?: string) {
    const services = await this.access.listServices(callerOf(req), typeof org === 'string' && org !== '' ? org : undefined);
    return { currentVersion: CURRENT_VERSION, folders: [], services };
  }

  @Public()
  @Get('services/:service/FeatureServer')
  async service(@Req() req: Request, @Param('service') name: string) {
    const svc = await this.access.service(callerOf(req), name);
    const refs = await Promise.all(
      svc.layers.map(async ({ index, layer }) => {
        const resolved = await this.access.layer(svc, String(index));
        return { index, name: layerName(layer), geometryType: resolved.query.geometryType };
      }),
    );
    return serviceDoc({
      title: svc.title,
      description: svc.description,
      layers: refs,
      extent: await this.serviceExtent(svc),
    });
  }

  @Public()
  @Get('services/:service/FeatureServer/layers')
  async layers(@Req() req: Request, @Param('service') name: string) {
    const svc = await this.access.service(callerOf(req), name);
    const docs = await Promise.all(svc.layers.map(({ index }) => this.layerDocFor(svc, String(index))));
    return {
      layers: docs.filter((d) => d.type !== 'Table'),
      tables: docs.filter((d) => d.type === 'Table'),
    };
  }

  @Public()
  @Get('services/:service/FeatureServer/:layer')
  async layer(@Req() req: Request, @Param('service') name: string, @Param('layer') layer: string) {
    const svc = await this.access.service(callerOf(req), name);
    return this.layerDocFor(svc, layer);
  }

  // Pro fires a query per layer on every pan and zoom: well above the
  // portal's default per-address limit for a working session.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 1200 } })
  @Get('services/:service/FeatureServer/:layer/query')
  async queryGet(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() params: RawParams,
  ) {
    return this.runQuery(req, name, layer, params);
  }

  // Clients POST a query whose URL would be too long (a big selection
  // polygon, a long ObjectID list). Same answer as the GET.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 1200 } })
  @Post('services/:service/FeatureServer/:layer/query')
  @HttpCode(200)
  async queryPost(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() params: RawParams,
    @Body() body: RawParams,
  ) {
    return this.runQuery(req, name, layer, { ...params, ...(body && typeof body === 'object' ? body : {}) });
  }

  private async layerDocFor(svc: ResolvedService, layerParam: string): Promise<Record<string, unknown>> {
    const { index, stored, query } = await this.access.layer(svc, layerParam);
    const extent =
      query.geometryType === null
        ? null
        : storedBbox(stored) ?? (await this.query.layerExtent(query.scope));
    return layerDoc({
      index,
      name: layerName(stored),
      description: svc.description,
      geometryType: query.geometryType,
      schema: query.schema,
      extent,
    });
  }

  private async serviceExtent(svc: ResolvedService): Promise<Extent | null> {
    let out: Extent | null = null;
    for (const { layer } of svc.layers) {
      if (layer.geometryType === null) continue;
      const e = storedBbox(layer) ?? (await this.query.layerExtent(`data_layer:${svc.itemId}:${layer.id}`));
      if (!e) continue;
      out = out
        ? {
            xmin: Math.min(out.xmin, e.xmin),
            ymin: Math.min(out.ymin, e.ymin),
            xmax: Math.max(out.xmax, e.xmax),
            ymax: Math.max(out.ymax, e.ymax),
          }
        : e;
    }
    return out;
  }

  private async runQuery(req: Request, name: string, layerParam: string, params: RawParams) {
    const svc = await this.access.service(callerOf(req), name);
    const { query: layer } = await this.access.layer(svc, layerParam);
    const isTable = layer.geometryType === null;
    const q = parseEsriQuery(params, layer.schema, isTable);
    const schema = layer.schema;
    const oidDoc = fieldDoc(schema.fields[0]!);

    if (q.statistics) {
      const rows = await this.query.statistics(layer, q, q.statistics);
      return {
        displayFieldName: '',
        fields: [
          ...q.groupBy.map(fieldDoc),
          ...q.statistics.map((s) => ({
            name: s.outName,
            type: (s.type === 'min' || s.type === 'max') && s.field.kind === 'string' ? 'esriFieldTypeString' : 'esriFieldTypeDouble',
            alias: s.outName,
          })),
        ],
        features: rows.map((attributes) => ({ attributes })),
      };
    }

    if (q.distinct) {
      const out = await this.query.distinct(layer, q);
      if (out.count !== null) return { count: out.count };
      return {
        fields: q.outFields.map(fieldDoc),
        features: out.rows.map((attributes) => ({ attributes })),
        ...(out.exceeded ? { exceededTransferLimit: true } : {}),
      };
    }

    if (q.idsOnly) {
      return { objectIdFieldName: schema.oidField, objectIds: await this.query.ids(layer, q) };
    }

    if (q.countOnly || q.extentOnly) {
      const out: Record<string, unknown> = {};
      if (q.countOnly) out.count = await this.query.count(layer, q);
      if (q.extentOnly) {
        const e = await this.query.extent(layer, q);
        out.extent = e ? extentDoc(e, srDoc(q.outSr)) : { xmin: null, ymin: null, xmax: null, ymax: null, spatialReference: srDoc(q.outSr) };
      }
      return out;
    }

    const page = await this.query.features(layer, q);
    if (q.format === 'geojson') {
      return {
        type: 'FeatureCollection',
        features: page.rows.map((r) => ({
          type: 'Feature',
          id: r.oid,
          geometry: r.geojson ?? null,
          properties: r.attributes,
        })),
        ...(page.exceeded ? { properties: { exceededTransferLimit: true } } : {}),
      };
    }
    const sr = srDoc(q.outSr);
    return {
      objectIdFieldName: schema.oidField,
      uniqueIdField: { name: schema.oidField, isSystemMaintained: true },
      globalIdFieldName: schema.globalIdField,
      ...(isTable ? {} : { geometryType: layer.geometryType, spatialReference: q.outSr === 4326 ? WGS84 : sr }),
      fields: [oidDoc, ...q.outFields.filter((f) => f.kind !== 'oid').map(fieldDoc)],
      features: page.rows.map((r) => (isTable ? { attributes: r.attributes } : { attributes: r.attributes, geometry: r.geometry ?? null })),
      ...(page.exceeded ? { exceededTransferLimit: true } : {}),
    };
  }
}
