// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { geoLimitSql, isClosedGeoLimit } from '../common/closed-geo-limit.js';
import { validateGeoJson } from '../common/geometry-validation.js';
import { LATEST_CREATE_ONLY } from '../engine/data-layer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { esriValue, toGlobalId, type EsriField, type EsriLayerSchema } from './esri-fields.js';
import { fieldExpr, compileWhere, orderBySql } from './esri-sql.js';
import { geojsonToEsri, type EsriGeometryType } from './esri-geometry.js';
import type { EsriQuery, OutStatistic } from './esri-query-params.js';
import { FeatureOidService } from './feature-oid.service.js';

/** One sublayer as the query sees it, with the caller's clips. */
export interface QueryLayer {
  scope: string;
  geometryType: EsriGeometryType | null;
  schema: EsriLayerSchema;
  /** Share or public-tier geographic limit; rows outside it are hidden. */
  geoLimit?: unknown;
  /** Share row scope: only rows this user created. */
  ownRowsOnly?: { userId: string };
}

export interface Extent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface FeatureRow {
  attributes: Record<string, string | number | null>;
  geometry?: Record<string, unknown> | null;
  /** GeoJSON geometry, kept for f=geojson. */
  geojson?: unknown;
  oid: number;
}

/** Most groups or distinct values one statistics query returns. */
const MAX_GROUPS = 10_000;

/**
 * The SQL behind FeatureServer queries. Rows are read from the
 * observation log the way every other read path reads them (the
 * latest version of each feature at or before now, deletes dropped),
 * driven from feature_oid so paging runs in ObjectID order. Every
 * clip the caller is under (share geo limit, public-tier boundary,
 * own rows only) is applied here, on every kind of query.
 */
@Injectable()
export class FeatureServerQueryService {
  private readonly srCache = new Map<number, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly oids: FeatureOidService,
  ) {}

  /** True when the SRID is geographic; 400 when PostGIS does not know it. */
  async checkSr(srid: number): Promise<boolean> {
    const hit = this.srCache.get(srid);
    if (hit !== undefined) return hit;
    const rows = await this.prisma.$queryRaw<Array<{ geographic: boolean }>>`
      SELECT (srtext LIKE 'GEOGCS%') AS geographic FROM spatial_ref_sys WHERE srid = ${srid}`;
    if (rows.length === 0) {
      throw new BadRequestException(`Spatial reference ${srid} is not known to this server.`);
    }
    const geographic = rows[0]!.geographic === true;
    this.srCache.set(srid, geographic);
    return geographic;
  }

  /** The filter geometry in EPSG:4326, or null. */
  private filterGeomSql(q: EsriQuery): Prisma.Sql | null {
    if (!q.geometry) return null;
    validateGeoJson(JSON.parse(q.geometry.geojson));
    let g = Prisma.sql`ST_SetSRID(ST_GeomFromGeoJSON(${q.geometry.geojson}::text), ${q.inSr}::int)`;
    if (q.geometry.rings) g = Prisma.sql`ST_BuildArea(${g})`;
    if (q.inSr !== 4326) g = Prisma.sql`ST_Transform(${g}, 4326)`;
    return g;
  }

  /**
   * The current rows of the layer the query may see, as a subquery
   * with columns oid, entity, attrs and geom. `content` is ANDed onto
   * the current version only, never onto older ones, so an edited or
   * deleted feature cannot come back through an old version.
   */
  private rowsSql(layer: QueryLayer, q: EsriQuery, fg: Prisma.Sql | null): Prisma.Sql {
    const scope = layer.scope;
    const candidate: Prisma.Sql[] = [];
    if (q.objectIds) {
      candidate.push(Prisma.sql`AND f.oid = ANY(${q.objectIds}::bigint[])`);
    }
    if (layer.ownRowsOnly) {
      candidate.push(Prisma.sql`AND f.entity IN (
        SELECT entity FROM observation
         WHERE scope = ${scope}
           AND kind = 'create'
           AND author_sub = ${layer.ownRowsOnly.userId}
           ${LATEST_CREATE_ONLY})`);
    }
    if (fg) {
      // Find candidates through the geometry index, over any version;
      // the exact test below runs on the current version.
      candidate.push(Prisma.sql`AND f.entity IN (
        SELECT o2.entity FROM observation o2
         WHERE o2.scope = ${scope} AND o2.geom && ${fg})`);
    }
    const content: Prisma.Sql[] = [Prisma.sql`AND ${compileWhere(q.where, layer.schema)}`];
    if (layer.geometryType !== null && layer.geoLimit !== undefined) {
      content.push(geoLimitSql(layer.geoLimit, 'geom', 'AND '));
    }
    if (fg) content.push(Prisma.sql`AND geom IS NOT NULL AND ${spatialTest(q.spatialRel, fg)}`);
    return Prisma.sql`(
      SELECT * FROM (
        SELECT f.oid, l.entity, l.attrs, l.geom
          FROM feature_oid f
          CROSS JOIN LATERAL (
            SELECT o.entity, o.attrs, o.geom, o.kind
              FROM observation o
             WHERE o.scope = ${scope}
               AND o.entity = f.entity
               AND o.valid_from <= now()
             ORDER BY o.valid_from DESC, o.tx_time DESC, o.id DESC
             LIMIT 1
          ) l
         WHERE f.scope = ${scope}
           AND l.kind <> 'delete'
           ${candidate.length > 0 ? Prisma.join(candidate, ' ') : Prisma.empty}
      ) cur
      WHERE TRUE ${Prisma.join(content, ' ')}
    ) c`;
  }

  /** Geometry of a row for the response, in the query's out SR. */
  private async geomOutSql(layer: QueryLayer, q: EsriQuery): Promise<Prisma.Sql> {
    const geographic = await this.checkSr(q.outSr);
    let g = Prisma.sql`geom`;
    if (q.outSr !== 4326) g = Prisma.sql`ST_Transform(${g}, ${q.outSr}::int)`;
    if (q.maxAllowableOffset && layer.geometryType !== 'esriGeometryPoint') {
      g = Prisma.sql`ST_SimplifyPreserveTopology(${g}, ${q.maxAllowableOffset}::float8)`;
    }
    const digits = q.geometryPrecision ?? (geographic ? 9 : 3);
    return Prisma.sql`ST_AsGeoJSON(${g}, ${digits}::int)`;
  }

  private async prepare(layer: QueryLayer, q: EsriQuery): Promise<Prisma.Sql> {
    await this.oids.ensureScopeForRequest(layer.scope);
    if (q.geometry) await this.checkSr(q.inSr);
    return this.rowsSql(layer, q, this.filterGeomSql(q));
  }

  /** One page of features. */
  async features(
    layer: QueryLayer,
    q: EsriQuery,
  ): Promise<{ rows: FeatureRow[]; exceeded: boolean }> {
    const rows = await this.prepare(layer, q);
    const withGeom = q.returnGeometry && layer.geometryType !== null;
    const geomCol = withGeom ? Prisma.sql`, ${await this.geomOutSql(layer, q)} AS gj` : Prisma.empty;
    const raw = await this.prisma.$queryRaw<
      Array<{ oid: bigint; entity: string; attrs: Record<string, unknown> | null; gj?: string | null }>
    >`SELECT oid, entity, attrs ${geomCol}
        FROM ${rows}
       ORDER BY ${orderBySql(q.orderBy)}
       LIMIT ${q.count + 1} OFFSET ${q.offset}`;
    const exceeded = raw.length > q.count;
    const page = exceeded ? raw.slice(0, q.count) : raw;
    const fields = q.outFields.filter((f) => f.kind !== 'oid');
    return {
      exceeded,
      rows: page.map((r) => {
        const oid = Number(r.oid);
        const attributes: Record<string, string | number | null> = { [layer.schema.oidField]: oid };
        for (const f of fields) {
          attributes[f.name] =
            f.kind === 'globalid' ? toGlobalId(r.entity) : esriValue(f.kind, r.attrs?.[f.attr!]);
        }
        const row: FeatureRow = { oid, attributes };
        if (withGeom) {
          const gj = r.gj ? (JSON.parse(r.gj) as { type?: string; coordinates?: unknown }) : null;
          row.geometry = gj ? geojsonToEsri(gj, layer.geometryType!) : null;
          row.geojson = gj;
        }
        return row;
      }),
    };
  }

  /** Every matching ObjectID, ascending. Not paged: clients that ask
   *  for ids alone (QGIS, Pro's selection) expect all of them. */
  async ids(layer: QueryLayer, q: EsriQuery): Promise<number[]> {
    const rows = await this.prepare(layer, q);
    const raw = await this.prisma.$queryRaw<Array<{ oid: bigint }>>`
      SELECT oid FROM ${rows} ORDER BY oid`;
    return raw.map((r) => Number(r.oid));
  }

  async count(layer: QueryLayer, q: EsriQuery): Promise<number> {
    const rows = await this.prepare(layer, q);
    const raw = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM ${rows}`;
    return Number(raw[0]?.n ?? 0);
  }

  /** Extent of the matching features in the query's out SR, or null when none have geometry. */
  async extent(layer: QueryLayer, q: EsriQuery): Promise<Extent | null> {
    const rows = await this.prepare(layer, q);
    const raw = await this.prisma.$queryRaw<Array<Partial<Extent>>>`
      SELECT ST_XMin(b) AS xmin, ST_YMin(b) AS ymin, ST_XMax(b) AS xmax, ST_YMax(b) AS ymax
        FROM (SELECT ST_Extent(geom) AS b FROM ${rows}) x`;
    return this.project(toExtent(raw[0]), q.outSr);
  }

  /**
   * Extent of every feature ever written to the layer, for the layer
   * and service documents. Older versions count too, so this can be a
   * little wide; it is one cheap scan, where the exact extent would
   * read the current version of every feature.
   */
  async layerExtent(scope: string): Promise<Extent | null> {
    const raw = await this.prisma.$queryRaw<Array<Partial<Extent>>>`
      SELECT ST_XMin(b) AS xmin, ST_YMin(b) AS ymin, ST_XMax(b) AS xmax, ST_YMax(b) AS ymax
        FROM (SELECT ST_Extent(geom) AS b FROM observation WHERE scope = ${scope} AND kind <> 'delete') x`;
    return toExtent(raw[0]);
  }

  /** Project a 4326 extent. Latitudes are held inside Web Mercator's range first. */
  async project(e: Extent | null, srid: number): Promise<Extent | null> {
    if (!e || srid === 4326) return e;
    await this.checkSr(srid);
    const raw = await this.prisma.$queryRaw<Array<Partial<Extent>>>`
      SELECT ST_XMin(t) AS xmin, ST_YMin(t) AS ymin, ST_XMax(t) AS xmax, ST_YMax(t) AS ymax
        FROM (SELECT ST_Transform(ST_MakeEnvelope(
          greatest(${e.xmin}::float8, -180), greatest(${e.ymin}::float8, -85.05112878),
          least(${e.xmax}::float8, 180), least(${e.ymax}::float8, 85.05112878), 4326), ${srid}::int) AS t) x`;
    return toExtent(raw[0]);
  }

  /**
   * Reproject edit geometries from `srid` to EPSG:4326, in one round
   * trip. Null stays null.
   */
  async toWgs84(geoms: Array<unknown | null>, srid: number): Promise<Array<unknown | null>> {
    if (srid === 4326 || geoms.every((g) => g === null)) return geoms;
    await this.checkSr(srid);
    const texts = geoms.map((g) => (g === null ? null : JSON.stringify(g)));
    const raw = await this.prisma.$queryRaw<Array<{ ord: number; gj: string | null }>>`
      SELECT c.ord::int AS ord,
             CASE WHEN c.g IS NULL THEN NULL
                  ELSE ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(c.g), ${srid}::int), 4326), 9)
             END AS gj
        FROM unnest(${texts}::text[]) WITH ORDINALITY AS c(g, ord)`;
    const out: Array<unknown | null> = geoms.slice();
    for (const r of raw) out[Number(r.ord) - 1] = r.gj ? JSON.parse(r.gj) : null;
    return out;
  }

  /**
   * Indexes of the geometries that fall outside the caller's
   * geographic limit, the same test the portal's feature routes apply
   * to writes. Null geometries pass: they cannot leave the area.
   */
  async outsideLimit(geoLimit: unknown, geoms: Array<unknown | null>): Promise<Set<number>> {
    const out = new Set<number>();
    const idx = geoms.flatMap((g, i) => (g === null ? [] : [i]));
    if (geoLimit === undefined || geoLimit === null || idx.length === 0) return out;
    if (isClosedGeoLimit(geoLimit)) return new Set(idx);
    const raw = await this.prisma.$queryRaw<Array<{ ord: number }>>`
      WITH lim AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geoLimit)}::text), 4326) AS g)
      SELECT c.ord::int AS ord
        FROM unnest(${idx.map((i) => JSON.stringify(geoms[i]))}::text[]) WITH ORDINALITY AS c(geom, ord), lim
       WHERE ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON(c.geom), 4326), lim.g) IS NOT TRUE`;
    for (const r of raw) out.add(idx[Number(r.ord) - 1]!);
    return out;
  }

  /** outStatistics, grouped or not. */
  async statistics(
    layer: QueryLayer,
    q: EsriQuery,
    stats: OutStatistic[],
  ): Promise<Array<Record<string, string | number | null>>> {
    const rows = await this.prepare(layer, q);
    const groups = q.groupBy.map((f, i) => Prisma.sql`${outputExpr(f)} AS ${Prisma.raw(`g${i}`)}`);
    const aggs = stats.map((s, i) => Prisma.sql`${aggregateExpr(s)} AS ${Prisma.raw(`s${i}`)}`);
    const select = Prisma.join([...groups, ...aggs], ', ');
    const groupBy =
      q.groupBy.length > 0
        ? Prisma.sql`GROUP BY ${Prisma.join(q.groupBy.map((_, i) => Prisma.raw(`g${i}`)), ', ')}
                     ORDER BY ${Prisma.join(q.groupBy.map((_, i) => Prisma.raw(`g${i}`)), ', ')}`
        : Prisma.empty;
    const raw = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT ${select} FROM ${rows} ${groupBy} LIMIT ${MAX_GROUPS}`;
    return raw.map((r) => {
      const out: Record<string, string | number | null> = {};
      q.groupBy.forEach((f, i) => {
        out[f.name] = outputValue(f, r[`g${i}`]);
      });
      stats.forEach((s, i) => {
        const v = r[`s${i}`];
        out[s.outName] =
          v === null || v === undefined
            ? null
            : typeof v === 'string' && s.field.kind === 'string'
              ? v
              : Number(v);
      });
      return out;
    });
  }

  /** returnDistinctValues: the distinct combinations of outFields. */
  async distinct(
    layer: QueryLayer,
    q: EsriQuery,
  ): Promise<{ rows: Array<Record<string, string | number | null>>; exceeded: boolean; count: number | null }> {
    const rows = await this.prepare(layer, q);
    const fields = q.outFields;
    const cols = Prisma.join(
      fields.map((f, i) => Prisma.sql`${outputExpr(f)} AS ${Prisma.raw(`d${i}`)}`),
      ', ',
    );
    if (q.countOnly) {
      const raw = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM (SELECT DISTINCT ${cols} FROM ${rows}) x`;
      return { rows: [], exceeded: false, count: Number(raw[0]?.n ?? 0) };
    }
    const order = Prisma.join(fields.map((_, i) => Prisma.raw(`d${i}`)), ', ');
    const raw = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT DISTINCT ${cols} FROM ${rows} ORDER BY ${order}
       LIMIT ${q.count + 1} OFFSET ${q.offset}`;
    const exceeded = raw.length > q.count;
    return {
      count: null,
      exceeded,
      rows: (exceeded ? raw.slice(0, q.count) : raw).map((r) => {
        const out: Record<string, string | number | null> = {};
        fields.forEach((f, i) => {
          out[f.name] = outputValue(f, r[`d${i}`]);
        });
        return out;
      }),
    };
  }
}

function spatialTest(rel: EsriQuery['spatialRel'], fg: Prisma.Sql): Prisma.Sql {
  switch (rel) {
    case 'envelope':
      return Prisma.sql`geom && ${fg}`;
    case 'contains':
      return Prisma.sql`ST_Contains(${fg}, geom)`;
    case 'within':
      return Prisma.sql`ST_Within(${fg}, geom)`;
    case 'crosses':
      return Prisma.sql`ST_Crosses(geom, ${fg})`;
    case 'overlaps':
      return Prisma.sql`ST_Overlaps(geom, ${fg})`;
    case 'touches':
      return Prisma.sql`ST_Touches(geom, ${fg})`;
    default:
      return Prisma.sql`ST_Intersects(geom, ${fg})`;
  }
}

/** A field's value as a plain SQL value for statistics and distinct lists. */
function outputExpr(f: EsriField): Prisma.Sql {
  switch (f.kind) {
    case 'oid':
      return Prisma.sql`oid::float8`;
    case 'globalid':
      return Prisma.sql`entity::text`;
    case 'date':
      return Prisma.sql`(extract(epoch FROM ${fieldExpr(f)}) * 1000)::float8`;
    case 'integer':
    case 'double':
      return Prisma.sql`${fieldExpr(f)}::float8`;
    default:
      return fieldExpr(f);
  }
}

function outputValue(f: EsriField, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (f.kind === 'globalid') return toGlobalId(String(v));
  if (f.kind === 'string' || f.kind === 'multi') return String(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function aggregateExpr(s: OutStatistic): Prisma.Sql {
  const f = s.field;
  if (s.type === 'count') {
    return f.kind === 'oid' || f.kind === 'globalid'
      ? Prisma.sql`count(*)::float8`
      : Prisma.sql`count(${fieldExpr(f)})::float8`;
  }
  if ((s.type === 'min' || s.type === 'max') && f.kind === 'string') {
    return s.type === 'min' ? Prisma.sql`min(${fieldExpr(f)})` : Prisma.sql`max(${fieldExpr(f)})`;
  }
  if ((s.type === 'min' || s.type === 'max') && f.kind === 'date') {
    const agg = s.type === 'min' ? Prisma.sql`min(${fieldExpr(f)})` : Prisma.sql`max(${fieldExpr(f)})`;
    return Prisma.sql`(extract(epoch FROM ${agg}) * 1000)::float8`;
  }
  const v = Prisma.sql`${fieldExpr(f)}::float8`;
  switch (s.type) {
    case 'sum':
      return Prisma.sql`sum(${v})`;
    case 'min':
      return Prisma.sql`min(${v})`;
    case 'max':
      return Prisma.sql`max(${v})`;
    case 'avg':
      return Prisma.sql`avg(${v})`;
    case 'stddev':
      return Prisma.sql`stddev_samp(${v})`;
    default:
      return Prisma.sql`var_samp(${v})`;
  }
}

function toExtent(r: Partial<Extent> | undefined): Extent | null {
  if (!r) return null;
  const vals = [r.xmin, r.ymin, r.xmax, r.ymax].map((v) => (v === null || v === undefined ? NaN : Number(v)));
  if (vals.some((v) => !Number.isFinite(v))) return null;
  return { xmin: vals[0]!, ymin: vals[1]!, xmax: vals[2]!, ymax: vals[3]! };
}
