// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable } from '@nestjs/common';
import type { GeoJsonGeometry } from '@gratis-gis/engine';

import { assertGeometryFamilies } from '../data-layer/geometry-family.js';
import {
  DataLayerFeaturesService,
  type EditBatch,
  type EditBatchResult,
  type EditOutcome,
  type EditPlan,
} from '../data-layer/features.service.js';
import { EditError, editList, esriToGeojson, fromEsriAttributes, geometryWkid } from './esri-edit.js';
import { fromGlobalId, toGlobalId } from './esri-fields.js';
import type { FeatureScopeFilter } from '../items/sharing.service.js';
import { FeatureOidService } from './feature-oid.service.js';
import { FeatureServerAccessService, type ResolvedService } from './featureserver-access.service.js';
import { FeatureServerQueryService, type QueryLayer } from './featureserver-query.service.js';

/** Most edits one request may carry, across all its layers. */
export const MAX_EDITS = 2000;

export interface EsriEditResult {
  objectId: number | null;
  globalId: string | null;
  success: boolean;
  error?: { code: number; description: string };
}

export interface LayerEdits {
  adds: unknown[];
  updates: unknown[];
  deletes: unknown[];
}

export interface LayerEditResults {
  id: number;
  addResults: EsriEditResult[];
  updateResults: EsriEditResult[];
  deleteResults: EsriEditResult[];
}

/** What a request said, before it was checked: one slot per edit. */
interface Parsed {
  index: number;
  layer: QueryLayer;
  layerId: string;
  /** Pre-check failures by list position. */
  failed: { adds: Map<number, EditError>; updates: Map<number, EditError>; deletes: Map<number, EditError> };
  /** ObjectIDs the client named, by list position, for the response. */
  oids: { updates: Array<number | null>; deletes: Array<number | null> };
  batch: EditBatch;
  /** Positions in the request of each batch entry. */
  pos: { adds: number[]; updates: number[]; deletes: number[] };
  counts: { adds: number; updates: number; deletes: number };
}

function attr(attrs: unknown, name: string): unknown {
  if (!attrs || typeof attrs !== 'object') return undefined;
  const key = Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (attrs as Record<string, unknown>)[key];
}

/**
 * applyEdits, addFeatures, updateFeatures and deleteFeatures. The Esri
 * shapes are turned into the portal's own edit batch and written by
 * DataLayerFeaturesService, so permissions, validation and history are
 * the portal's: nothing here writes a feature itself.
 */
@Injectable()
export class FeatureServerEditService {
  constructor(
    private readonly access: FeatureServerAccessService,
    private readonly query: FeatureServerQueryService,
    private readonly oids: FeatureOidService,
    private readonly features: DataLayerFeaturesService,
  ) {}

  /** Edits on several layers of one service, in one transaction. */
  async apply(
    svc: ResolvedService,
    edits: Array<{ layer: string; edits: LayerEdits }>,
    opts: { useGlobalIds: boolean; rollbackOnFailure: boolean },
  ): Promise<LayerEditResults[]> {
    const total = edits.reduce((n, e) => n + e.edits.adds.length + e.edits.updates.length + e.edits.deletes.length, 0);
    if (total > MAX_EDITS) {
      throw new BadRequestException(`One request may carry at most ${MAX_EDITS} edits. Save in smaller batches.`);
    }
    if (new Set(edits.map((e) => e.layer)).size !== edits.length) {
      throw new BadRequestException('Each layer may appear once in edits.');
    }
    const user = svc.user!;
    const parsed: Parsed[] = [];
    for (const e of edits) parsed.push(await this.parse(svc, e.layer, e.edits, opts.useGlobalIds));

    const plans: EditPlan[] = [];
    for (const p of parsed) {
      // The layer's write scope, resolved by access.layer(..., 'edit').
      const shareScope: FeatureScopeFilter = {};
      if (p.layer.geoLimit !== undefined) shareScope.geoLimit = p.layer.geoLimit as NonNullable<FeatureScopeFilter['geoLimit']>;
      if (p.layer.ownRowsOnly) shareScope.ownRowsOnly = p.layer.ownRowsOnly;
      plans.push(
        await this.features.prepareEditBatch(svc.itemId, p.layerId, user, p.batch, {
          shareScope,
          isTable: p.layer.geometryType === null,
        }),
      );
    }

    // A pre-check failure fails the whole request under rollback, the
    // same as a failed check in the plan.
    const preFailed = parsed.some(
      (p) => p.failed.adds.size + p.failed.updates.size + p.failed.deletes.size > 0,
    );
    let results: EditBatchResult[];
    if (preFailed && opts.rollbackOnFailure) {
      results = plans.map((plan) => ({
        layerId: plan.layerId,
        adds: plan.adds.map(notApplied),
        updates: plan.updates.map(notApplied),
        deletes: plan.deletes.map(notApplied),
        applied: false,
      }));
    } else {
      results = await this.features.commitEditPlans(svc.itemId, user, plans, opts.rollbackOnFailure);
    }

    const out: LayerEditResults[] = [];
    for (let k = 0; k < parsed.length; k++) {
      const p = parsed[k]!;
      const r = results[k]!;
      // New features got their ObjectID from the trigger as they were written.
      const newIds = r.adds.flatMap((o) => (o.ok && o.globalId ? [o.globalId] : []));
      const newOids = await this.oids.oidsFor(p.layer.scope, newIds);
      const assemble = (
        count: number,
        failed: Map<number, EditError>,
        pos: number[],
        outcomes: EditOutcome[],
        oidAt: (i: number, o: EditOutcome | undefined) => number | null,
        globalIdAt: (i: number) => string | null,
      ): EsriEditResult[] => {
        const byPos = new Map<number, EditOutcome>();
        pos.forEach((at, j) => byPos.set(at, outcomes[j]!));
        const res: EsriEditResult[] = [];
        for (let i = 0; i < count; i++) {
          const pre = failed.get(i);
          const o = byPos.get(i);
          const objectId = oidAt(i, o);
          const globalId = o?.globalId ? toGlobalId(o.globalId) : globalIdAt(i);
          if (pre) {
            res.push({ objectId, globalId, success: false, error: { code: pre.code, description: pre.message } });
          } else if (preFailed && opts.rollbackOnFailure) {
            res.push({
              objectId,
              globalId,
              success: false,
              error: { code: 1000, description: 'Not applied: another edit in this request failed.' },
            });
          } else if (o && !o.ok) {
            res.push({ objectId, globalId, success: false, error: { code: o.code, description: o.message } });
          } else {
            res.push({ objectId, globalId, success: true });
          }
        }
        return res;
      };
      out.push({
        id: p.index,
        addResults: assemble(
          p.counts.adds,
          p.failed.adds,
          p.pos.adds,
          r.adds,
          (_i, o) => (o?.ok && o.globalId && newOids.has(o.globalId) ? Number(newOids.get(o.globalId)) : null),
          () => null,
        ),
        updateResults: assemble(p.counts.updates, p.failed.updates, p.pos.updates, r.updates, (i) => p.oids.updates[i] ?? null, () => null),
        deleteResults: assemble(p.counts.deletes, p.failed.deletes, p.pos.deletes, r.deletes, (i) => p.oids.deletes[i] ?? null, () => null),
      });
    }
    return out;
  }

  /** Turn one layer's Esri edits into an EditBatch, failing what cannot be read. */
  private async parse(svc: ResolvedService, layerParam: string, edits: LayerEdits, useGlobalIds: boolean): Promise<Parsed> {
    const { index, stored, query: layer } = await this.access.layer(svc, layerParam, 'edit');
    const schema = layer.schema;
    const isTable = layer.geometryType === null;
    const failed = { adds: new Map<number, EditError>(), updates: new Map<number, EditError>(), deletes: new Map<number, EditError>() };
    const guard = <T>(map: Map<number, EditError>, i: number, fn: () => T): T | undefined => {
      try {
        return fn();
      } catch (err) {
        map.set(i, err instanceof EditError ? err : new EditError(err instanceof Error ? err.message : String(err)));
        return undefined;
      }
    };

    // Read every edit.
    type Shaped = { i: number; props: Record<string, unknown>; geom: GeoJsonGeometry | null | undefined; wkid: number | null; idRef: unknown };
    const readFeature = (raw: unknown, i: number, map: Map<number, EditError>, idField: string): Shaped | undefined =>
      guard(map, i, () => {
        if (!raw || typeof raw !== 'object') throw new EditError('Each feature must be an object.');
        const f = raw as { attributes?: unknown; geometry?: unknown };
        const props = fromEsriAttributes(schema, f.attributes);
        let geom: GeoJsonGeometry | null | undefined;
        if (!isTable && f.geometry !== undefined && f.geometry !== null) {
          geom = esriToGeojson(f.geometry, layer.geometryType!);
          if (geom) {
            try {
              assertGeometryFamilies((stored.geometryType ?? null) as never, [geom]);
            } catch (err) {
              throw new EditError(err instanceof Error ? err.message : String(err));
            }
          }
        }
        return { i, props, geom, wkid: geometryWkid(f.geometry), idRef: attr(f.attributes, idField) };
      });

    const adds = edits.adds.map((raw, i) => readFeature(raw, i, failed.adds, schema.globalIdField));
    const updates = edits.updates.map((raw, i) =>
      readFeature(raw, i, failed.updates, useGlobalIds ? schema.globalIdField : schema.oidField),
    );

    // Geometries sent in another spatial reference.
    const shaped = [...adds, ...updates].filter((s): s is Shaped => !!s && !!s.geom);
    const bySr = new Map<number, Shaped[]>();
    for (const s of shaped) {
      const w = s.wkid ?? 4326;
      if (w !== 4326) bySr.set(w, [...(bySr.get(w) ?? []), s]);
    }
    for (const [srid, list] of bySr) {
      const moved = await this.query.toWgs84(list.map((s) => s.geom!), srid);
      list.forEach((s, k) => {
        s.geom = (moved[k] as GeoJsonGeometry | null) ?? null;
      });
    }

    // Inside the caller's geographic limit, as the portal checks writes.
    const outside = await this.query.outsideLimit(layer.geoLimit, shaped.map((s) => s.geom ?? null));
    const outsideErr = (): EditError => new EditError('The geometry is outside the area you may edit.');
    shaped.forEach((s, k) => {
      if (!outside.has(k)) return;
      const inAdds = adds.includes(s);
      (inAdds ? failed.adds : failed.updates).set(s.i, outsideErr());
    });

    // Which feature each update and delete names.
    const deletesRaw = edits.deletes;
    const oidsForUpdates: Array<number | null> = updates.map((u) =>
      !useGlobalIds && u && typeof u.idRef === 'number' ? u.idRef : null,
    );
    const oidsForDeletes: Array<number | null> = deletesRaw.map((d) =>
      !useGlobalIds && (typeof d === 'number' || (typeof d === 'string' && /^\d+$/.test(d))) ? Number(d) : null,
    );
    let entityByOid = new Map<bigint, string>();
    if (!useGlobalIds) {
      const wanted = [...oidsForUpdates, ...oidsForDeletes].filter((n): n is number => n !== null && Number.isSafeInteger(n) && n > 0);
      entityByOid = await this.oids.entitiesFor(layer.scope, wanted.map((n) => BigInt(n)));
    }
    const entityOf = (ref: unknown, oid: number | null): string | null => {
      if (useGlobalIds) return typeof ref === 'string' ? fromGlobalId(ref) : null;
      return oid !== null ? (entityByOid.get(BigInt(oid)) ?? null) : null;
    };

    const batch: EditBatch = { adds: [], updates: [], deletes: [] };
    const pos = { adds: [] as number[], updates: [] as number[], deletes: [] as number[] };
    adds.forEach((a, i) => {
      if (!a || failed.adds.has(i)) return;
      const gid = useGlobalIds && typeof a.idRef === 'string' ? fromGlobalId(a.idRef) : null;
      if (useGlobalIds && a.idRef !== undefined && a.idRef !== null && !gid) {
        failed.adds.set(i, new EditError('The GlobalID is not a valid id.'));
        return;
      }
      batch.adds.push({ ...(gid ? { globalId: gid } : {}), properties: a.props, geometry: a.geom ?? null });
      pos.adds.push(i);
    });
    updates.forEach((u, i) => {
      if (!u || failed.updates.has(i)) return;
      const entity = entityOf(u.idRef, oidsForUpdates[i] ?? null);
      if (!entity) {
        failed.updates.set(i, new EditError('The feature does not exist, or you cannot edit it.', 1019));
        return;
      }
      batch.updates.push({
        globalId: entity,
        ...(Object.keys(u.props).length > 0 ? { properties: u.props } : {}),
        ...(u.geom ? { geometry: u.geom } : {}),
      });
      pos.updates.push(i);
    });
    deletesRaw.forEach((d, i) => {
      const entity = entityOf(d, oidsForDeletes[i] ?? null);
      if (!entity) {
        failed.deletes.set(i, new EditError('The feature does not exist, or you cannot edit it.', 1019));
        return;
      }
      batch.deletes.push(entity);
      pos.deletes.push(i);
    });

    return {
      index,
      layer,
      layerId: stored.id,
      failed,
      oids: { updates: oidsForUpdates, deletes: oidsForDeletes },
      batch,
      pos,
      counts: { adds: edits.adds.length, updates: edits.updates.length, deletes: deletesRaw.length },
    };
  }
}

function notApplied(o: EditOutcome): EditOutcome {
  return o.ok
    ? { ok: false, code: 1000, message: 'Not applied: another edit in this request failed.', ...(o.globalId ? { globalId: o.globalId } : {}) }
    : o;
}

/** `deletes` as Esri sends it: a JSON list, or comma-separated ids. */
export function deleteList(raw: unknown): unknown[] {
  if (typeof raw === 'string' && raw.trim() !== '' && !raw.trim().startsWith('[')) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return editList(raw, 'deletes');
}

