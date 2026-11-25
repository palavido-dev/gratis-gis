// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
} from '@nestjs/common';
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
import { absoluteBase } from '../public/ogc/url.js';
import { EditError, editList } from './esri-edit.js';
import { EsriErrorFilter, invalidToken, tokenRequired } from './esri-error.filter.js';
import { param, parseEsriQuery, srDoc, type RawParams } from './esri-query-params.js';
import { FeatureServerEditService, MAX_EDITS, deleteList, type LayerEdits } from './featureserver-edit.service.js';
import { FeatureServerAccessService, type ResolvedService, type StoredLayer } from './featureserver-access.service.js';
import { FeatureServerQueryService, type Extent } from './featureserver-query.service.js';

/**
 * The caller. A token that did not check out answers Esri's "invalid
 * token" (498), so the client signs in again instead of carrying on as
 * anonymous and seeing private layers vanish.
 */
function callerOf(req: Request): AuthUser | null {
  const r = req as Request & { user?: AuthUser | null; esriTokenInvalid?: boolean };
  if (r.esriTokenInvalid === true) throw invalidToken();
  return r.user ?? null;
}

function flag(p: RawParams, name: string, dflt: boolean): boolean {
  const v = param(p, name)?.trim().toLowerCase();
  if (v === undefined || v === '') return dflt;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new BadRequestException(`${name} must be true or false.`);
}

function merged(query: RawParams, body: RawParams): RawParams {
  return { ...query, ...(body && typeof body === 'object' ? body : {}) };
}

/** An EditError for the whole request is a 400. */
function list(raw: unknown, name: string): unknown[] {
  try {
    return name === 'deletes' ? deleteList(raw) : editList(raw, name);
  } catch (err) {
    if (err instanceof EditError) throw new BadRequestException(err.message);
    throw err;
  }
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
    private readonly edits: FeatureServerEditService,
  ) {}

  @Public()
  @Get('info')
  info(@Req() req: Request) {
    return infoDoc(`${absoluteBase(req)}/api/arcgis/tokens/generateToken`);
  }

  /**
   * A service, or the right refusal: a signed-in caller who may not
   * read it gets 404, an anonymous one Esri's "token required", which
   * is what makes ArcGIS Pro show its sign-in prompt. The same answer
   * whether or not the service exists.
   */
  private async serviceFor(req: Request, name: string): Promise<ResolvedService> {
    const user = callerOf(req);
    try {
      return await this.access.service(user, name);
    } catch (err) {
      if (err instanceof NotFoundException && !user) throw tokenRequired();
      throw err;
    }
  }

  /** A service the caller is signed in to, for edits. */
  private async editableService(req: Request, name: string): Promise<ResolvedService> {
    const svc = await this.serviceFor(req, name);
    if (!svc.user) throw tokenRequired();
    return svc;
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
    const svc = await this.serviceFor(req, name);
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
      editable: svc.layers.some(({ layer }) => this.access.canEdit(svc, layer)),
    });
  }

  @Public()
  @Get('services/:service/FeatureServer/layers')
  async layers(@Req() req: Request, @Param('service') name: string) {
    const svc = await this.serviceFor(req, name);
    const docs = await Promise.all(svc.layers.map(({ index }) => this.layerDocFor(svc, String(index))));
    return {
      layers: docs.filter((d) => d.type !== 'Table'),
      tables: docs.filter((d) => d.type === 'Table'),
    };
  }

  @Public()
  @Get('services/:service/FeatureServer/:layer')
  async layer(@Req() req: Request, @Param('service') name: string, @Param('layer') layer: string) {
    const svc = await this.serviceFor(req, name);
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

  // ---------------------------------------------------------- edits

  /** Service-level applyEdits: what ArcGIS Pro calls when it saves. */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('services/:service/FeatureServer/applyEdits')
  @HttpCode(200)
  async serviceApplyEdits(
    @Req() req: Request,
    @Param('service') name: string,
    @Query() q: RawParams,
    @Body() b: RawParams,
  ) {
    const p = merged(q, b);
    const svc = await this.editableService(req, name);
    const raw = list(param(p, 'edits'), 'edits');
    if (raw.length === 0) throw new BadRequestException('edits must list at least one layer.');
    const edits = raw.map((e) => {
      if (!e || typeof e !== 'object') throw new BadRequestException('Each entry of edits must be an object.');
      const o = e as { id?: unknown; adds?: unknown; updates?: unknown; deletes?: unknown };
      if (typeof o.id !== 'number' && typeof o.id !== 'string') {
        throw new BadRequestException('Each entry of edits needs the layer id.');
      }
      return {
        layer: String(o.id),
        edits: { adds: list(o.adds, 'adds'), updates: list(o.updates, 'updates'), deletes: list(o.deletes, 'deletes') },
      };
    });
    return this.edits.apply(svc, edits, {
      useGlobalIds: flag(p, 'useGlobalIds', false),
      rollbackOnFailure: flag(p, 'rollbackOnFailure', true),
    });
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('services/:service/FeatureServer/:layer/applyEdits')
  @HttpCode(200)
  async applyEdits(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() q: RawParams,
    @Body() b: RawParams,
  ) {
    const p = merged(q, b);
    const edits: LayerEdits = {
      adds: list(param(p, 'adds'), 'adds'),
      updates: list(param(p, 'updates'), 'updates'),
      deletes: list(param(p, 'deletes'), 'deletes'),
    };
    const [r] = await this.edits.apply(await this.editableService(req, name), [{ layer, edits }], {
      useGlobalIds: flag(p, 'useGlobalIds', false),
      rollbackOnFailure: flag(p, 'rollbackOnFailure', true),
    });
    return { addResults: r!.addResults, updateResults: r!.updateResults, deleteResults: r!.deleteResults };
  }

  /** QGIS edits through these three. */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('services/:service/FeatureServer/:layer/addFeatures')
  @HttpCode(200)
  async addFeatures(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() q: RawParams,
    @Body() b: RawParams,
  ) {
    const p = merged(q, b);
    const edits: LayerEdits = { adds: list(param(p, 'features'), 'features'), updates: [], deletes: [] };
    const [r] = await this.edits.apply(await this.editableService(req, name), [{ layer, edits }], {
      useGlobalIds: flag(p, 'useGlobalIds', false),
      rollbackOnFailure: flag(p, 'rollbackOnFailure', true),
    });
    return { addResults: r!.addResults };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('services/:service/FeatureServer/:layer/updateFeatures')
  @HttpCode(200)
  async updateFeatures(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() q: RawParams,
    @Body() b: RawParams,
  ) {
    const p = merged(q, b);
    const edits: LayerEdits = { adds: [], updates: list(param(p, 'features'), 'features'), deletes: [] };
    const [r] = await this.edits.apply(await this.editableService(req, name), [{ layer, edits }], {
      useGlobalIds: flag(p, 'useGlobalIds', false),
      rollbackOnFailure: flag(p, 'rollbackOnFailure', true),
    });
    return { updateResults: r!.updateResults };
  }

  /** By objectIds, or by a where clause and geometry like a query. */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('services/:service/FeatureServer/:layer/deleteFeatures')
  @HttpCode(200)
  async deleteFeatures(
    @Req() req: Request,
    @Param('service') name: string,
    @Param('layer') layer: string,
    @Query() q: RawParams,
    @Body() b: RawParams,
  ) {
    const p = merged(q, b);
    const svc = await this.editableService(req, name);
    const hasFilter = ['objectIds', 'where', 'geometry'].some((k) => (param(p, k) ?? '').trim() !== '');
    if (!hasFilter) throw new BadRequestException('deleteFeatures needs objectIds, where or geometry.');
    const { query: readLayer } = await this.access.layer(svc, layer, 'edit');
    const q2 = parseEsriQuery(
      {
        ...(param(p, 'objectIds') ? { objectIds: param(p, 'objectIds') } : {}),
        ...(param(p, 'where') ? { where: param(p, 'where') } : {}),
        ...(param(p, 'geometry') ? { geometry: param(p, 'geometry') } : {}),
        ...(param(p, 'geometryType') ? { geometryType: param(p, 'geometryType') } : {}),
        ...(param(p, 'inSR') ? { inSR: param(p, 'inSR') } : {}),
        ...(param(p, 'spatialRel') ? { spatialRel: param(p, 'spatialRel') } : {}),
      },
      readLayer.schema,
      readLayer.geometryType === null,
    );
    const ids = await this.query.ids(readLayer, q2);
    if (ids.length > MAX_EDITS) {
      throw new BadRequestException(`That would delete ${ids.length} features; one request may delete at most ${MAX_EDITS}.`);
    }
    const [r] = await this.edits.apply(svc, [{ layer, edits: { adds: [], updates: [], deletes: ids } }], {
      useGlobalIds: false,
      rollbackOnFailure: flag(p, 'rollbackOnFailure', true),
    });
    return { deleteResults: r!.deleteResults };
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
      editable: this.access.canEdit(svc, stored),
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
    const svc = await this.serviceFor(req, name);
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
          ...q.groupBy.map((f) => fieldDoc(f)),
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
        fields: q.outFields.map((f) => fieldDoc(f)),
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
      fields: [oidDoc, ...q.outFields.filter((f) => f.kind !== 'oid').map((f) => fieldDoc(f))],
      features: page.rows.map((r) => (isTable ? { attributes: r.attributes } : { attributes: r.attributes, geometry: r.geometry ?? null })),
      ...(page.exceeded ? { exceededTransferLimit: true } : {}),
    };
  }
}
