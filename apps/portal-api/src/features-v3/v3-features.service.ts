import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { toV3TableName } from './v3-tables.service.js';

/**
 * Per-layer feature CRUD for v3 data_layer items.
 *
 * Lifecycle (create/alter/drop tables) lives in V3TablesService; this
 * service only handles row-level operations against already-provisioned
 * tables. ItemsService's get() / sharing checks should be applied by
 * the controller before reaching here.
 */

export interface V3FeatureInsert {
  globalId?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | undefined;
}

export interface V3FeatureOut {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
}

interface V3Row {
  gid: bigint;
  global_id: string;
  geom: string | null;
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  created_by: string;
  created_at: Date;
  edited_by: string;
  edited_at: Date;
}

@Injectable()
export class V3FeaturesService {
  private readonly log = new Logger(V3FeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Current-state feature collection for a layer. Supports bbox
   *  filter + point-in-time (?at=) in the usual temporal-table form,
   *  plus an optional `geoLimit` GeoJSON geometry that intersects
   *  every returned row (used to enforce per-share geographic
   *  restrictions). */
  async listFeatures(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: V3FeatureOut[] }> {
    const tbl = toV3TableName(itemId, layerId);
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    if (opts.at) {
      params.push(opts.at);
      whereClauses.push(
        `valid_from <= $${params.length} AND (valid_to IS NULL OR valid_to > $${params.length})`,
      );
    } else {
      whereClauses.push(`valid_to IS NULL`);
    }
    if (opts.bbox) {
      params.push(opts.bbox[0], opts.bbox[1], opts.bbox[2], opts.bbox[3]);
      const n = params.length;
      whereClauses.push(
        `geom && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)`,
      );
    }
    if (opts.geoLimit) {
      // Rows either intersect the allowed polygon, or have no geometry
      // at all (attribute-only rows leak through here and are filtered
      // by the controller's parent-layer inheritance logic for related
      // tables). ST_GeomFromGeoJSON handles Polygon, MultiPolygon, and
      // GeometryCollection variants in the same call.
      params.push(JSON.stringify(opts.geoLimit));
      const n = params.length;
      whereClauses.push(
        `(geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)))`,
      );
    }
    const sql = `
      SELECT gid, global_id, ST_AsGeoJSON(geom) AS geom, properties,
             valid_from, valid_to, created_by, created_at, edited_by, edited_at
      FROM "${tbl}"
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY gid
    `;
    const rows = await this.prisma.$queryRawUnsafe<V3Row[]>(sql, ...params);
    return {
      type: 'FeatureCollection',
      features: rows.map(rowToFeature),
    };
  }

  /** Bulk-insert features. Accepts optional client-generated globalId
   *  so offline-authored features keep their identity post-sync. */
  async insertFeatures(
    itemId: string,
    layerId: string,
    inputs: V3FeatureInsert[],
    user: AuthUser,
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };
    const tbl = toV3TableName(itemId, layerId);
    const now = new Date();
    let inserted = 0;
    for (const f of inputs) {
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO "${tbl}"
          (global_id, geom, properties, valid_from, created_by, edited_by)
        VALUES
          (COALESCE($1::uuid, gen_random_uuid()),
           CASE WHEN $2::text IS NULL THEN NULL ELSE ST_GeomFromGeoJSON($2) END,
           $3::jsonb, $4, $5, $5)
        `,
        f.globalId ?? null,
        f.geometry ? JSON.stringify(f.geometry) : null,
        JSON.stringify(f.properties ?? {}),
        now,
        user.id,
      );
      inserted += 1;
    }
    this.log.log(`Inserted ${inserted} features into ${tbl}`);
    return { inserted };
  }

  /** Update a feature by expiring the current row and inserting a new
   *  one: same temporal-versioning pattern as the v2 features service. */
  async updateFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    patch: { geometry?: unknown; properties?: Record<string, unknown> },
    user: AuthUser,
  ): Promise<V3FeatureOut> {
    const tbl = toV3TableName(itemId, layerId);
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.$queryRawUnsafe<V3Row[]>(
        `
        SELECT gid, global_id, ST_AsGeoJSON(geom) AS geom, properties,
               valid_from, valid_to, created_by, created_at, edited_by, edited_at
        FROM "${tbl}"
        WHERE global_id = $1 AND valid_to IS NULL
        FOR UPDATE
        `,
        featureId,
      );
      if (!cur.length) throw new NotFoundException('Feature not found');
      const now = new Date();
      await tx.$executeRawUnsafe(
        `UPDATE "${tbl}" SET valid_to = $1, edited_by = $2, edited_at = $1 WHERE gid = $3`,
        now,
        user.id,
        cur[0]!.gid,
      );
      const nextGeometry =
        patch.geometry !== undefined
          ? patch.geometry
          : cur[0]!.geom
            ? JSON.parse(cur[0]!.geom)
            : null;
      const nextProps =
        patch.properties !== undefined ? patch.properties : cur[0]!.properties;
      const inserted = await tx.$queryRawUnsafe<V3Row[]>(
        `
        INSERT INTO "${tbl}"
          (global_id, geom, properties, valid_from, created_by, created_at, edited_by, edited_at)
        VALUES
          ($1, CASE WHEN $2::text IS NULL THEN NULL ELSE ST_GeomFromGeoJSON($2) END,
           $3::jsonb, $4, $5, $6, $5, $4)
        RETURNING gid, global_id, ST_AsGeoJSON(geom) AS geom, properties,
                  valid_from, valid_to, created_by, created_at, edited_by, edited_at
        `,
        featureId,
        nextGeometry ? JSON.stringify(nextGeometry) : null,
        JSON.stringify(nextProps),
        now,
        user.id,
        cur[0]!.created_at,
      );
      return rowToFeature(inserted[0]!);
    });
  }

  /** Expire (soft-delete) a feature. */
  async deleteFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    user: AuthUser,
  ): Promise<void> {
    const tbl = toV3TableName(itemId, layerId);
    const now = new Date();
    const affected = await this.prisma.$executeRawUnsafe(
      `
      UPDATE "${tbl}"
         SET valid_to = $1, edited_by = $2, edited_at = $1
       WHERE global_id = $3 AND valid_to IS NULL
      `,
      now,
      user.id,
      featureId,
    );
    if (affected === 0) throw new NotFoundException('Feature not found');
  }
}

function rowToFeature(row: V3Row): V3FeatureOut {
  let geometry: unknown = null;
  if (row.geom) {
    try {
      geometry = JSON.parse(row.geom);
    } catch {
      geometry = null;
    }
  }
  return {
    type: 'Feature',
    id: row.global_id,
    geometry,
    properties: row.properties,
  };
}
