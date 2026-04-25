import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching both PrismaService and Prisma.TransactionClient.
 * Lets the same private helper serve bulk inserts from either the live
 * service (non-transactional caller) or a transaction callback, so we
 * don't maintain two copies of the SQL.
 */
interface PrismaExecutor {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $queryRawUnsafe: <T = unknown>(
    sql: string,
    ...values: unknown[]
  ) => Promise<T>;
}

export interface FeatureRow {
  gid: bigint;
  global_id: string;
  geom: string | null; // GeoJSON geometry string
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  created_by: string;
  created_at: Date;
  edited_by: string;
  edited_at: Date;
}

export interface GeoJsonFeature {
  type: 'Feature';
  id: string; // global_id
  geometry: unknown;
  properties: Record<string, unknown>;
  _meta?: {
    gid: number;
    validFrom: string;
    /** null when feature is current; non-null when feature was expired (updated or deleted). */
    validTo: string | null;
    createdBy: string;
    createdAt: string;
    editedBy: string;
    editedAt: string;
  };
}

export interface QueryFeaturesOpts {
  /** EPSG:4326 [minX, minY, maxX, maxY] */
  bbox?: [number, number, number, number];
  limit?: number;
  offset?: number;
  /** ISO 8601 timestamp: return features valid at this moment */
  at?: string;
  /** ISO 8601 timestamp: delta-sync mode: return all rows touched since this cursor.
   *  Includes both current rows (valid_to IS NULL) and rows that were expired/deleted
   *  (valid_to >= since). Forces includeMeta=true so callers can detect tombstones. */
  since?: string;
  includeMeta?: boolean;
}

export interface InsertFeatureInput {
  /** Client-generated GUID for offline sync; omit to let the server generate one. */
  globalId?: string | undefined;
  /** GeoJSON geometry object. Omit or pass undefined for geometry-less features. */
  geometry?: unknown;
  properties: Record<string, unknown>;
}

export interface UpdateFeatureInput {
  geometry?: unknown;
  properties?: Record<string, unknown>;
}

export interface TableStats {
  featureCount: number;
  bbox: [number, number, number, number] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an item UUID to a safe PostgreSQL table name.
 * Only accepts properly-formatted UUIDs; throws for anything else so the
 * string can never be user-controlled SQL.
 */
function toTableName(itemId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new BadRequestException('Invalid item ID format');
  }
  return `fs_${itemId.replace(/-/g, '')}`;
}

function rowToFeature(row: FeatureRow, includeMeta: boolean): GeoJsonFeature {
  let geometry: unknown = null;
  if (row.geom) {
    try {
      geometry = JSON.parse(row.geom);
    } catch {
      geometry = null;
    }
  }
  const f: GeoJsonFeature = {
    type: 'Feature',
    id: row.global_id,
    geometry,
    properties: row.properties,
  };
  if (includeMeta) {
    f._meta = {
      gid: Number(row.gid),
      validFrom: row.valid_from.toISOString(),
      validTo: row.valid_to ? row.valid_to.toISOString() : null,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      editedBy: row.edited_by,
      editedAt: row.edited_at.toISOString(),
    };
  }
  return f;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Manages per-item PostGIS feature tables.
 *
 * Each data_layer item owns a dedicated table `fs_<uuid_no_dashes>`.
 * Rows are never overwritten: instead every update expires the old version
 * (sets valid_to = NOW()) and inserts a new one (valid_from = NOW(),
 * valid_to = NULL). Deletes likewise only set valid_to. This gives full
 * point-in-time query capability with no separate history table needed.
 *
 * Current state:   WHERE valid_to IS NULL
 * Point-in-time:   WHERE valid_from <= $t AND (valid_to IS NULL OR valid_to > $t)
 */
@Injectable()
export class FeaturesService {
  private readonly log = new Logger(FeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Table lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the PostGIS table for a feature service item. Idempotent
   * safe to call if the table already exists.
   */
  async provisionTable(itemId: string): Promise<void> {
    const tbl = toTableName(itemId);
    // Use raw template literal with $1 not possible for identifiers; we
    // validated the name above so interpolation is safe here.
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        gid         BIGSERIAL PRIMARY KEY,
        global_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
        geom        GEOMETRY(Geometry, 4326),
        properties  JSONB       NOT NULL DEFAULT '{}',
        valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to    TIMESTAMPTZ,
        created_by  UUID        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_by   UUID        NOT NULL,
        edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Spatial index for bbox queries.
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_geom_idx"
        ON "${tbl}" USING GIST (geom)
    `);
    // Index for point-in-time queries: filtering by valid_to IS NULL is
    // the hot path (current-state reads).
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_valid_to_idx"
        ON "${tbl}" (valid_to)
    `);
    // Index for stable feature identity lookups.
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_global_id_idx"
        ON "${tbl}" (global_id)
    `);
    // Partial UNIQUE index: at most one current (unexpired) row per
    // global_id. Concurrent updateFeature() / deleteFeature() calls
    // can't both insert a new live version: the loser hits a unique-
    // violation and fails cleanly instead of corrupting the table
    // with two "current" rows for the same feature.
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "${tbl}_current_uniq"
        ON "${tbl}" (global_id) WHERE valid_to IS NULL
    `);
    this.log.log(`Provisioned feature table ${tbl}`);
  }

  /**
   * Drop the feature table for an item. Called when the item is purged.
   * Idempotent: safe if the table never existed.
   */
  async dropTable(itemId: string): Promise<void> {
    const tbl = toTableName(itemId);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
    this.log.log(`Dropped feature table ${tbl}`);
  }

  /** True when the feature table exists (item has been upgraded to v2). */
  async tableExists(itemId: string): Promise<boolean> {
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<[{ exists: boolean }]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists
    `, tbl);
    return rows[0]?.exists ?? false;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Bulk-insert features. Each feature gets a fresh global_id unless the
   * caller supplies one (offline-created features arrive with a client-side
   * GUID so parent/child relationships established offline survive sync).
   *
   * Returns the count of inserted rows.
   */
  async bulkInsert(
    itemId: string,
    features: InsertFeatureInput[],
    user: AuthUser,
  ): Promise<{ inserted: number }> {
    if (features.length === 0) return { inserted: 0 };
    const tbl = toTableName(itemId);
    const inserted = await this.bulkInsertCore(this.prisma, tbl, features, user);
    return { inserted };
  }

  /**
   * Core bulk-insert loop. Takes any Prisma-like client that exposes
   * `$executeRawUnsafe` so callers can either pass the live service
   * or a transaction client. Returns the number of inserted rows.
   */
  private async bulkInsertCore(
    client: PrismaExecutor,
    tbl: string,
    features: InsertFeatureInput[],
    user: AuthUser,
  ): Promise<number> {
    if (features.length === 0) return 0;
    const now = new Date();
    let inserted = 0;

    // Insert in batches of 500 to avoid very large SQL strings.
    const BATCH = 500;
    for (let i = 0; i < features.length; i += BATCH) {
      const batch = features.slice(i, i + BATCH);
      // Build a VALUES clause with numbered params.
      // Params per row: global_id, geom, properties, valid_from, created_by, edited_by
      // geom uses ST_SetSRID(ST_GeomFromGeoJSON($n), 4326)
      const params: unknown[] = [];
      const valueParts: string[] = [];

      for (const feat of batch) {
        const base = params.length + 1;
        // Push all 6 params unconditionally so $base through $base+5 are
        // always defined. COALESCE handles the null globalId case in SQL.
        params.push(
          feat.globalId ?? null,                                  // $base
          feat.geometry ? JSON.stringify(feat.geometry) : null,  // $base+1
          JSON.stringify(feat.properties ?? {}),                  // $base+2
          now.toISOString(),                                      // $base+3 valid_from
          user.id,                                                // $base+4 created_by
          user.id,                                                // $base+5 edited_by
        );
        // Always reference all 6 params so PostgreSQL's param count stays
        // consistent across rows. COALESCE / CASE WHEN handle null inputs.
        valueParts.push(`(
          COALESCE($${base}::uuid, gen_random_uuid()),
          CASE WHEN $${base + 1}::text IS NOT NULL
               THEN ST_SetSRID(ST_GeomFromGeoJSON($${base + 1}), 4326)
               ELSE NULL END,
          $${base + 2}::jsonb,
          $${base + 3}::timestamptz,
          $${base + 4}::uuid,
          $${base + 5}::uuid
        )`);
      }

      await client.$executeRawUnsafe(
        `INSERT INTO "${tbl}"
           (global_id, geom, properties, valid_from, created_by, edited_by)
         VALUES ${valueParts.join(', ')}`,
        ...params,
      );
      inserted += batch.length;
    }

    return inserted;
  }

  /**
   * Replace ALL current features (valid_to IS NULL) with a new set.
   * Expires existing rows then bulk-inserts the replacement set,
   * wrapped in a single database transaction so a partial failure
   * can't leave the table in a "all expired, nothing inserted" state.
   */
  async replaceAll(
    itemId: string,
    features: InsertFeatureInput[],
    user: AuthUser,
  ): Promise<{ inserted: number; expired: number }> {
    const tbl = toTableName(itemId);
    const now = new Date().toISOString();

    return this.prisma.$transaction(async (tx) => {
      const expireResult = await tx.$executeRawUnsafe(
        `UPDATE "${tbl}"
            SET valid_to  = $1::timestamptz,
                edited_by = $2::uuid,
                edited_at = $1::timestamptz
          WHERE valid_to IS NULL`,
        now,
        user.id,
      );
      // $executeRawUnsafe returns the row count as a number.
      const expired = typeof expireResult === 'number' ? expireResult : 0;

      const inserted = await this.bulkInsertCore(tx, tbl, features, user);
      return { inserted, expired };
    });
  }

  /**
   * Update a single feature by its global_id: expire the current version
   * and insert a new one with the same global_id, preserving the original
   * created_by / created_at.
   */
  async updateFeature(
    itemId: string,
    globalId: string,
    patch: UpdateFeatureInput,
    user: AuthUser,
  ): Promise<GeoJsonFeature> {
    const tbl = toTableName(itemId);
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const now = new Date().toISOString();

    // Expire + insert has to be atomic: otherwise a concurrent caller
    // can read the same "current" row, both expire it, and both insert
    // new live rows (the partial UNIQUE index from provisionTable then
    // saves us by rejecting the second INSERT: the transaction lets
    // us report that cleanly instead of leaking a half-done update).
    // SELECT ... FOR UPDATE serializes concurrent updaters on the gid
    // so only one proceeds to expire + insert.
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRawUnsafe<FeatureRow[]>(
        `SELECT *,
                ST_AsGeoJSON(geom) AS geom
           FROM "${tbl}"
          WHERE global_id = $1::uuid AND valid_to IS NULL
          LIMIT 1
          FOR UPDATE`,
        globalId,
      );
      if (!current.length) throw new NotFoundException('Feature not found');
      const old = current[0]!;

      // Expire old version.
      await tx.$executeRawUnsafe(
        `UPDATE "${tbl}"
            SET valid_to  = $1::timestamptz,
                edited_by = $2::uuid,
                edited_at = $1::timestamptz
          WHERE gid = $3`,
        now,
        user.id,
        old.gid,
      );

      const newGeom = patch.geometry !== undefined
        ? patch.geometry
        : (old.geom ? JSON.parse(old.geom) : null);
      const newProps = patch.properties !== undefined
        ? { ...(old.properties as Record<string, unknown>), ...patch.properties }
        : old.properties;

      // Always pass geom as $4 (null when absent); CASE handles both branches.
      const inserted = await tx.$queryRawUnsafe<FeatureRow[]>(
        `INSERT INTO "${tbl}"
           (global_id, geom, properties, valid_from, created_by, created_at, edited_by, edited_at)
         VALUES (
           $1::uuid,
           CASE WHEN $4::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($4), 4326) ELSE NULL END,
           $5::jsonb,
           $2::timestamptz,
           $3::uuid,
           $6::timestamptz,
           $3::uuid,
           $2::timestamptz
         )
         RETURNING *, ST_AsGeoJSON(geom) AS geom`,
        globalId,
        now,
        user.id,
        newGeom ? JSON.stringify(newGeom) : null,
        JSON.stringify(newProps),
        old.created_at.toISOString(),
      );

      return rowToFeature(inserted[0]!, true);
    });
  }

  /**
   * Soft-delete a feature by expiring its current version.
   */
  async deleteFeature(
    itemId: string,
    globalId: string,
    user: AuthUser,
  ): Promise<void> {
    const tbl = toTableName(itemId);
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const now = new Date().toISOString();
    const result = await this.prisma.$executeRawUnsafe(
      `UPDATE "${tbl}"
          SET valid_to  = $1::timestamptz,
              edited_by = $2::uuid,
              edited_at = $1::timestamptz
        WHERE global_id = $3::uuid AND valid_to IS NULL`,
      now,
      user.id,
      globalId,
    );
    if ((result as number) === 0) {
      throw new NotFoundException('Feature not found');
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Query features. Returns current-state by default; pass `opts.at` for
   * a point-in-time view. Optionally filter by bounding box.
   */
  async query(
    itemId: string,
    opts: QueryFeaturesOpts = {},
  ): Promise<GeoJsonFeature[]> {
    const tbl = toTableName(itemId);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (opts.since) {
      // Delta-sync mode: return all rows touched since the cursor: both new/updated
      // rows (valid_from >= since) and rows that were expired/deleted (valid_to >= since).
      // includeMeta is forced below so callers can identify tombstones via validTo.
      const ts = new Date(opts.since);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid since timestamp');
      params.push(ts.toISOString());
      const p = params.length;
      conditions.push(
        `(valid_from >= $${p}::timestamptz OR (valid_to IS NOT NULL AND valid_to >= $${p}::timestamptz))`,
      );
    } else if (opts.at) {
      const ts = new Date(opts.at);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid at timestamp');
      params.push(ts.toISOString());
      const p = params.length;
      conditions.push(`valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`);
    } else {
      conditions.push('valid_to IS NULL');
    }

    if (opts.bbox) {
      const [minX, minY, maxX, maxY] = opts.bbox;
      params.push(minX, minY, maxX, maxY);
      const b = params.length;
      conditions.push(
        `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${Math.min(opts.limit, 10_000)}` : 'LIMIT 10000';
    const offset = opts.offset ? `OFFSET ${opts.offset}` : '';

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        ${where}
        ORDER BY gid
        ${limit} ${offset}`,
      ...params,
    );

    // since-mode always includes meta so callers can detect tombstones (validTo != null).
    const meta = opts.includeMeta ?? (opts.since !== undefined);
    return rows.map((r) => rowToFeature(r, meta));
  }

  /**
   * Fetch a single feature by global_id. Returns the current version
   * unless `at` is specified.
   */
  async getFeature(
    itemId: string,
    globalId: string,
    at?: string,
  ): Promise<GeoJsonFeature> {
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const tbl = toTableName(itemId);
    const params: unknown[] = [globalId];
    let temporalClause: string;

    if (at) {
      const ts = new Date(at);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid at timestamp');
      params.push(ts.toISOString());
      temporalClause = `AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)`;
    } else {
      temporalClause = 'AND valid_to IS NULL';
    }

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE global_id = $1::uuid ${temporalClause}
        LIMIT 1`,
      ...params,
    );
    if (!rows.length) throw new NotFoundException('Feature not found');
    return rowToFeature(rows[0]!, true);
  }

  /**
   * Retrieve version history for a feature (all versions, newest first).
   */
  async getHistory(itemId: string, globalId: string): Promise<GeoJsonFeature[]> {
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE global_id = $1::uuid
        ORDER BY valid_from DESC`,
      globalId,
    );
    return rows.map((r) => rowToFeature(r, true));
  }

  /**
   * Compute feature count and bounding box for the item metadata.
   * Returns null bbox when there are no features or all geometries are null.
   */
  async stats(itemId: string): Promise<TableStats> {
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<
      [{ cnt: bigint; minx: number | null; miny: number | null; maxx: number | null; maxy: number | null }]
    >(
      `SELECT
         COUNT(*)                            AS cnt,
         ST_XMin(ST_Extent(geom))::float8   AS minx,
         ST_YMin(ST_Extent(geom))::float8   AS miny,
         ST_XMax(ST_Extent(geom))::float8   AS maxx,
         ST_YMax(ST_Extent(geom))::float8   AS maxy
         FROM "${tbl}"
        WHERE valid_to IS NULL`,
    );
    const r = rows[0];
    const featureCount = Number(r?.cnt ?? 0);
    const bbox: [number, number, number, number] | null =
      r?.minx != null && r?.miny != null && r?.maxx != null && r?.maxy != null
        ? [r.minx, r.miny, r.maxx, r.maxy]
        : null;
    return { featureCount, bbox };
  }

  /**
   * Return the full current-state GeoJSON FeatureCollection suitable for
   * direct consumption by MapLibre. Streams all current features.
   */
  async toGeoJsonCollection(
    itemId: string,
    opts: Pick<QueryFeaturesOpts, 'bbox' | 'at'> = {},
  ): Promise<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }> {
    const features = await this.query(itemId, { ...opts, limit: 10_000 });
    return { type: 'FeatureCollection', features };
  }

  // -------------------------------------------------------------------------
  // Related tables
  // -------------------------------------------------------------------------

  /**
   * Add a UUID foreign-key column to a child feature table. Idempotent
   * safe to call if the column already exists. Used when registering a
   * parent-child relationship.
   *
   * The column is indexed so that `WHERE <fkColumn> = $parentGlobalId`
   * queries are fast even on large datasets.
   */
  async addParentKeyColumn(childItemId: string, fkColumn: string): Promise<void> {
    // Column names must be plain identifiers. Reject anything suspicious.
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(fkColumn)) {
      throw new BadRequestException('Invalid FK column name');
    }
    const tbl = toTableName(childItemId);
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "${fkColumn}" UUID`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${tbl}_${fkColumn}_idx" ON "${tbl}" ("${fkColumn}")`,
    );
    this.log.log(`Added FK column ${fkColumn} to ${tbl}`);
  }

  /**
   * Fetch related features from a child table for a given parent global_id.
   * Returns only current versions (valid_to IS NULL) by default.
   */
  async getRelatedFeatures(
    childItemId: string,
    parentGlobalId: string,
    fkColumn: string,
    opts: Pick<QueryFeaturesOpts, 'limit' | 'offset' | 'at' | 'includeMeta'> = {},
  ): Promise<GeoJsonFeature[]> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(fkColumn)) {
      throw new BadRequestException('Invalid FK column name');
    }
    if (!/^[0-9a-f-]{36}$/i.test(parentGlobalId)) {
      throw new BadRequestException('Invalid parent feature id');
    }
    const tbl = toTableName(childItemId);
    const params: unknown[] = [parentGlobalId];
    const conditions: string[] = [`"${fkColumn}" = $1::uuid`];

    if (opts.at) {
      const ts = new Date(opts.at);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid at timestamp');
      params.push(ts.toISOString());
      const p = params.length;
      conditions.push(
        `valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`,
      );
    } else {
      conditions.push('valid_to IS NULL');
    }

    const limit = Math.min(opts.limit ?? 500, 5_000);
    const offset = opts.offset ?? 0;

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE ${conditions.join(' AND ')}
        ORDER BY gid
        LIMIT ${limit} OFFSET ${offset}`,
      ...params,
    );
    return rows.map((r) => rowToFeature(r, opts.includeMeta ?? false));
  }

  /**
   * Insert a single related feature (child) linked to a parent by the
   * FK column. The parentGlobalId is written into both the FK column
   * and the feature's properties for convenience.
   */
  async createRelatedFeature(
    childItemId: string,
    parentGlobalId: string,
    fkColumn: string,
    input: InsertFeatureInput,
    user: AuthUser,
  ): Promise<GeoJsonFeature> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(fkColumn)) {
      throw new BadRequestException('Invalid FK column name');
    }
    if (!/^[0-9a-f-]{36}$/i.test(parentGlobalId)) {
      throw new BadRequestException('Invalid parent feature id');
    }
    const tbl = toTableName(childItemId);
    const now = new Date().toISOString();

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `INSERT INTO "${tbl}"
         (global_id, "${fkColumn}", geom, properties, valid_from, created_by, edited_by)
       VALUES (
         COALESCE($1::uuid, gen_random_uuid()),
         $2::uuid,
         CASE WHEN $3::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($3), 4326) ELSE NULL END,
         $4::jsonb,
         $5::timestamptz,
         $6::uuid,
         $6::uuid
       )
       RETURNING *, ST_AsGeoJSON(geom) AS geom`,
      input.globalId ?? null,
      parentGlobalId,
      input.geometry ? JSON.stringify(input.geometry) : null,
      JSON.stringify(input.properties ?? {}),
      now,
      user.id,
    );

    if (!rows.length) {
      throw new NotFoundException('Insert did not return a row');
    }
    return rowToFeature(rows[0]!, true);
  }

}
