// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { lookupField, parseOrderBy, type OrderTerm } from './esri-sql.js';
import type { EsriField, EsriLayerSchema } from './esri-fields.js';
import { parseFilterGeometry, type FilterGeometry } from './esri-geometry.js';
import { parseEsriWhere, type WhereNode } from './esri-where.js';

/** Most features one query page returns. Pro pages past this. */
export const MAX_RECORD_COUNT = 2000;
/** Most ObjectIDs one query may name in `objectIds`. */
export const MAX_OBJECT_IDS = 20_000;

export type SpatialRel = 'intersects' | 'envelope' | 'contains' | 'within' | 'crosses' | 'overlaps' | 'touches';

export type StatType = 'count' | 'sum' | 'min' | 'max' | 'avg' | 'stddev' | 'var';

export interface OutStatistic {
  type: StatType;
  field: EsriField;
  outName: string;
}

export interface EsriQuery {
  format: 'json' | 'geojson';
  where: WhereNode;
  objectIds: number[] | null;
  /** Fields to return besides the ObjectID; null means every field. */
  outFields: EsriField[];
  returnGeometry: boolean;
  outSr: number;
  inSr: number;
  geometry: FilterGeometry | null;
  spatialRel: SpatialRel;
  offset: number;
  count: number;
  orderBy: OrderTerm[];
  idsOnly: boolean;
  countOnly: boolean;
  extentOnly: boolean;
  distinct: boolean;
  statistics: OutStatistic[] | null;
  groupBy: EsriField[];
  maxAllowableOffset: number | null;
  geometryPrecision: number | null;
}

export type RawParams = Record<string, unknown>;

function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

/** One string value of a parameter; repeated parameters keep the first. */
export function param(p: RawParams, name: string): string | undefined {
  // Esri parameter names are case-insensitive in practice.
  const key = Object.keys(p).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const v = p[key];
  const one = Array.isArray(v) ? v[0] : v;
  if (one === undefined || one === null) return undefined;
  return typeof one === 'string' ? one : typeof one === 'object' ? JSON.stringify(one) : String(one);
}

function bool(p: RawParams, name: string, dflt: boolean): boolean {
  const v = param(p, name)?.trim().toLowerCase();
  if (v === undefined || v === '') return dflt;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw bad(`${name} must be true or false.`);
}

function int(p: RawParams, name: string, dflt: number, min: number, max: number): number {
  const v = param(p, name)?.trim();
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw bad(`${name} must be a whole number of ${min} or more.`);
  return Math.min(n, max);
}

/** Esri's Web Mercator wkids all mean EPSG:3857. */
const WEB_MERCATOR = new Set([102100, 102113, 900913, 3857]);

/** A spatial reference parameter: a wkid, or `{"wkid":..}` / `{"latestWkid":..}`. */
export function parseSr(raw: string | undefined, dflt: number): number {
  const v = raw?.trim();
  if (v === undefined || v === '') return dflt;
  let wkid: unknown = Number(v);
  if (!Number.isFinite(wkid as number)) {
    try {
      const o = JSON.parse(v) as { wkid?: unknown; latestWkid?: unknown };
      wkid = o.latestWkid ?? o.wkid;
    } catch {
      wkid = undefined;
    }
  }
  if (typeof wkid !== 'number' || !Number.isInteger(wkid) || wkid <= 0) {
    throw bad('A spatial reference must be a wkid number, for example 4326 or 102100.');
  }
  return WEB_MERCATOR.has(wkid) ? 3857 : wkid;
}

/** The spatial reference object for responses. */
export function srDoc(srid: number): { wkid: number; latestWkid: number } {
  return srid === 3857 ? { wkid: 102100, latestWkid: 3857 } : { wkid: srid, latestWkid: srid };
}

const SPATIAL_REL: Record<string, SpatialRel> = {
  esrispatialrelintersects: 'intersects',
  esrispatialrelindexintersects: 'envelope',
  esrispatialrelenvelopeintersects: 'envelope',
  esrispatialrelcontains: 'contains',
  esrispatialrelwithin: 'within',
  esrispatialrelcrosses: 'crosses',
  esrispatialreloverlaps: 'overlaps',
  esrispatialreltouches: 'touches',
};

const STAT_TYPES = new Set<StatType>(['count', 'sum', 'min', 'max', 'avg', 'stddev', 'var']);

function fieldList(raw: string | undefined, schema: EsriLayerSchema, what: string): EsriField[] | null {
  const v = raw?.trim();
  if (v === undefined || v === '') return [];
  if (v === '*') return null;
  const out: EsriField[] = [];
  for (const name of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (name === '*') return null;
    const f = schema.byLower.get(name.toLowerCase());
    if (!f) throw bad(`${what}: the layer has no field named "${name}".`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

function parseStatistics(raw: string, schema: EsriLayerSchema): OutStatistic[] {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw bad('outStatistics is not valid JSON.');
  }
  if (!Array.isArray(list) || list.length === 0) throw bad('outStatistics must be a list of statistics.');
  if (list.length > 50) throw bad('outStatistics may list at most 50 statistics.');
  const names = new Set<string>();
  return list.map((s: { statisticType?: unknown; onStatisticField?: unknown; outStatisticFieldName?: unknown }) => {
    const type = String(s?.statisticType ?? '').toLowerCase() as StatType;
    if (!STAT_TYPES.has(type)) {
      throw bad(`statisticType "${String(s?.statisticType)}" is not supported. Use count, sum, min, max, avg, stddev or var.`);
    }
    if (typeof s.onStatisticField !== 'string') throw bad('Each statistic needs onStatisticField.');
    const field = lookupField(schema, s.onStatisticField.trim());
    const numeric = field.kind === 'integer' || field.kind === 'double' || field.kind === 'oid' || field.kind === 'boolean';
    if (!numeric && type !== 'count' && type !== 'min' && type !== 'max') {
      throw bad(`${type} needs a number field; ${field.name} is not one.`);
    }
    if (field.kind === 'multi' || (field.kind === 'globalid' && type !== 'count')) {
      throw bad(`${type} does not work on ${field.name}.`);
    }
    const outName =
      typeof s.outStatisticFieldName === 'string' && s.outStatisticFieldName.trim() !== ''
        ? s.outStatisticFieldName.trim()
        : `${type}_${field.name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(outName)) {
      throw bad(`outStatisticFieldName "${outName}" must be letters, numbers and underscores.`);
    }
    if (names.has(outName.toLowerCase())) throw bad(`outStatisticFieldName "${outName}" is used twice.`);
    names.add(outName.toLowerCase());
    return { type, field, outName };
  });
}

/** Read the parameters of a FeatureServer layer query. */
export function parseEsriQuery(p: RawParams, schema: EsriLayerSchema, isTable: boolean): EsriQuery {
  const f = (param(p, 'f') ?? 'json').trim().toLowerCase();
  if (f === 'pbf') throw bad('This server answers queries as JSON. Ask for f=json.');
  const format = f === 'geojson' ? 'geojson' : 'json';

  const distance = param(p, 'distance')?.trim();
  if (distance && Number(distance) !== 0) {
    throw bad('Queries with a distance are not supported. Buffer the geometry instead.');
  }

  let objectIds: number[] | null = null;
  const idsRaw = param(p, 'objectIds')?.trim();
  if (idsRaw) {
    const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > MAX_OBJECT_IDS) throw bad(`objectIds may list at most ${MAX_OBJECT_IDS} ObjectIDs.`);
    objectIds = ids.map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 1) throw bad(`objectIds: "${s}" is not an ObjectID.`);
      return n;
    });
  }

  const outFields = fieldList(param(p, 'outFields'), schema, 'outFields');
  const geomRaw = param(p, 'geometry');
  const geometry = !isTable && geomRaw && geomRaw.trim() !== '' ? parseFilterGeometry(geomRaw, param(p, 'geometryType')) : null;
  const relRaw = param(p, 'spatialRel')?.trim().toLowerCase();
  const spatialRel = relRaw ? SPATIAL_REL[relRaw] : 'intersects';
  if (!spatialRel) throw bad(`spatialRel ${param(p, 'spatialRel')} is not supported.`);

  const statsRaw = param(p, 'outStatistics')?.trim();
  const statistics = statsRaw ? parseStatistics(statsRaw, schema) : null;
  const groupBy = statistics ? fieldList(param(p, 'groupByFieldsForStatistics'), schema, 'groupByFieldsForStatistics') : [];
  if (groupBy === null) throw bad('groupByFieldsForStatistics must name fields, not *.');
  if (groupBy.some((g) => g.kind === 'multi')) throw bad('A field with several choices cannot be grouped on.');

  const distinct = bool(p, 'returnDistinctValues', false);
  if (distinct && (outFields === null || outFields.length === 0)) {
    throw bad('returnDistinctValues needs outFields to name the fields.');
  }

  const mao = param(p, 'maxAllowableOffset')?.trim();
  const maxAllowableOffset = mao ? Number(mao) : null;
  if (maxAllowableOffset !== null && !(Number.isFinite(maxAllowableOffset) && maxAllowableOffset >= 0)) {
    throw bad('maxAllowableOffset must be a number of 0 or more.');
  }
  const gp = param(p, 'geometryPrecision')?.trim();
  const geometryPrecision = gp ? Number(gp) : null;
  if (geometryPrecision !== null && !(Number.isInteger(geometryPrecision) && geometryPrecision >= 0 && geometryPrecision <= 15)) {
    throw bad('geometryPrecision must be a whole number from 0 to 15.');
  }

  const inSr = parseSr(param(p, 'inSR'), geometry?.wkid ? parseSr(String(geometry.wkid), 4326) : 4326);

  return {
    format,
    where: parseEsriWhere(param(p, 'where')),
    objectIds,
    outFields: outFields ?? schema.fields.filter((x) => x.kind !== 'oid'),
    returnGeometry: !isTable && bool(p, 'returnGeometry', true),
    outSr: parseSr(param(p, 'outSR'), 4326),
    inSr,
    geometry,
    spatialRel,
    offset: int(p, 'resultOffset', 0, 0, Number.MAX_SAFE_INTEGER),
    count: int(p, 'resultRecordCount', MAX_RECORD_COUNT, 1, MAX_RECORD_COUNT),
    orderBy: parseOrderBy(param(p, 'orderByFields'), schema),
    idsOnly: bool(p, 'returnIdsOnly', false),
    countOnly: bool(p, 'returnCountOnly', false),
    extentOnly: !isTable && bool(p, 'returnExtentOnly', false),
    distinct,
    statistics,
    groupBy,
    maxAllowableOffset: maxAllowableOffset || null,
    geometryPrecision,
  };
}
