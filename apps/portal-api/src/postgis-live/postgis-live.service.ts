// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import type {
  MapLayerFilter,
  MapLayerFilterClause,
  PostgisLiveLayerSnapshot,
  PostgisLiveService,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialService } from '../items/credential.service.js';
import { SharingService } from '../items/sharing.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  listGeometryTablesPreview,
  MAX_TEST_CONNECTION_TABLES,
  type PostgisTablePreview,
} from './postgis-table-preview.js';

export {
  listGeometryTablesPreview,
  MAX_TEST_CONNECTION_TABLES,
  type PostgisTablePreview,
} from './postgis-table-preview.js';

/**
 * #158 PostGIS live-read.
 *
 * Service that connects to a registered PostgreSQL + PostGIS
 * database, probes its tables, and serves bbox-filtered GeoJSON
 * to a portal map. The connection itself lives on a `service`
 * item with `protocol: 'postgis_live'`; the password is stored
 * encrypted via the existing ItemCredential pattern (auth kind
 * `basic`) so the browser never sees it.
 *
 * Per-request safety guards:
 *   - Connection pool is created lazily per service item id and
 *     cached; the pool reuses idle connections so a quick scroll
 *     across a map doesn't open and close PG connections on
 *     every viewport change.
 *   - `statement_timeout` is set on every connection check-out so
 *     a runaway query (bad index, accidental sequential scan on
 *     a multi-billion row table) can't tie up the database.
 *   - The schema and table names go through a strict identifier
 *     regex before they're interpolated into the SELECT; the
 *     WHERE clause (when supplied) gets the same gate. No
 *     statement terminators, no comment sequences.
 *   - Output rows are bounded by a hard cap so a wide bbox over
 *     a dense table can't fill the browser.
 *
 * Non-WGS84 geometry columns are reprojected with ST_Transform
 * on read (bbox into the source SRID for the GiST index; geometry
 * out to 4326 for GeoJSON). Structured MapLayer.filter compiles
 * to parameterized SQL on the same path.
 */
const MAX_FEATURES_PER_REQUEST = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const WHERE_CLAUSE_BLOCKLIST = /[;]|--|\/\*|\*\//;

@Injectable()
export class PostgisLiveService_ {
  private readonly log = new Logger(PostgisLiveService_.name);
  /** itemId -> pg Pool. Lazily created and reused across
   *  requests; idle connections close after a short timeout. */
  private readonly pools = new Map<string, Pool>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
    private readonly sharing: SharingService,
  ) {}

  /**
   * Probe a registered service item: list every table in the
   * default schema (or `public` when none specified) that has a
   * geometry column, plus the schema + column inventory needed
   * to render and filter it. Idempotent: the wizard hits this
   * during create to seed `layers[]` on the service item and
   * again on demand from the detail page to refresh.
   */
  async probe(
    user: AuthUser,
    serviceItemId: string,
  ): Promise<PostgisLiveLayerSnapshot[]> {
    const item = await this.loadService(user, serviceItemId);
    const data = item.data as unknown as PostgisLiveService;
    const pool = await this.getPool(serviceItemId, data);
    const client = await pool.connect();
    try {
      await client.query(
        `SET statement_timeout = ${data.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}`,
      );
      const schema = data.defaultSchema ?? 'public';
      if (!IDENTIFIER_RE.test(schema)) {
        throw new BadRequestException(
          `Invalid schema name "${schema}". Schemas must match ` +
            `[A-Za-z_][A-Za-z0-9_]{0,62}.`,
        );
      }
      // List geometry columns first (one row per geometry column
      // per table). This is the canonical source of truth for
      // "tables PostGIS knows about in this schema."
      const geomRows = await client.query<{
        f_table_schema: string;
        f_table_name: string;
        f_geometry_column: string;
        coord_dimension: number;
        srid: number;
        type: string;
      }>(
        `SELECT f_table_schema, f_table_name, f_geometry_column,
                coord_dimension, srid, type
         FROM geometry_columns
         WHERE f_table_schema = $1
         ORDER BY f_table_name, f_geometry_column`,
        [schema],
      );
      const layers: PostgisLiveLayerSnapshot[] = [];
      for (const row of geomRows.rows) {
        const tableName = `${row.f_table_schema}.${row.f_table_name}`;
        const columns = await client.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
             AND column_name <> $3
           ORDER BY ordinal_position`,
          [row.f_table_schema, row.f_table_name, row.f_geometry_column],
        );
        // Try a quick ST_Extent on a tiny sample to seed the
        // bbox. Skip for large tables (where ST_Extent over the
        // full row count would be expensive); the detail page
        // can run a deeper refresh on demand.
        let bbox: [number, number, number, number] | undefined;
        try {
          const ext = await client.query<{ minx: number; miny: number; maxx: number; maxy: number }>(
            `SELECT ST_XMin(b) AS minx, ST_YMin(b) AS miny,
                    ST_XMax(b) AS maxx, ST_YMax(b) AS maxy
             FROM (
               SELECT ST_Extent(${quoteIdent(row.f_geometry_column)})::box2d AS b
               FROM ${quoteIdent(row.f_table_schema)}.${quoteIdent(row.f_table_name)}
               TABLESAMPLE BERNOULLI (1)
             ) e`,
          );
          const r = ext.rows[0];
          if (
            r &&
            Number.isFinite(r.minx) &&
            Number.isFinite(r.miny) &&
            Number.isFinite(r.maxx) &&
            Number.isFinite(r.maxy)
          ) {
            bbox = [r.minx, r.miny, r.maxx, r.maxy];
          }
        } catch (err) {
          // Sample bbox is best-effort; an empty table or one
          // without a planner statistic returns no rows. Log and
          // continue.
          this.log.debug(
            `bbox sample skipped for ${tableName}: ${err instanceof Error ? err.message : err}`,
          );
        }
        layers.push({
          name: tableName,
          title: tableName,
          geometryColumn: row.f_geometry_column,
          geometryKind: row.type,
          srid: row.srid,
          columns: columns.rows.map((c) => ({ name: c.column_name, type: c.data_type })),
          ...(bbox ? { bbox } : {}),
        });
      }
      return layers;
    } finally {
      client.release();
    }
  }

  /**
   * Fetch features from a registered table as a GeoJSON
   * FeatureCollection. Bbox-filtered server-side via the &&
   * operator (uses the GiST index when present). Hard-capped at
   * MAX_FEATURES_PER_REQUEST so a wide bbox over a dense table
   * can't fill the model context.
   */
  async readFeatures(
    user: AuthUser,
    serviceItemId: string,
    args: {
      tableName: string;
      bbox?: [number, number, number, number];
      whereClause?: string;
      /**
       * #158 Phase 1.5: structured MapLayer.filter, compiled to a
       * parameterized SQL fragment server-side. Lets the visual
       * filter editor narrow the row set at the database instead
       * of pulling the bbox-wide result back to the browser and
       * filtering in MapLibre. The free-form `whereClause` field
       * stays as the power-user escape hatch and is ANDed in
       * alongside.
       */
      filter?: MapLayerFilter | null;
      limit?: number;
    },
  ): Promise<{
    type: 'FeatureCollection';
    features: unknown[];
    truncated: boolean;
  }> {
    const item = await this.loadService(user, serviceItemId);
    const data = item.data as unknown as PostgisLiveService;
    const layer = (data.layers as PostgisLiveLayerSnapshot[] | undefined)?.find(
      (l) => l.name === args.tableName,
    );
    if (!layer) {
      throw new NotFoundException(
        `Table "${args.tableName}" is not registered on this service`,
      );
    }
    const [schema, table] = splitTableName(args.tableName);
    if (!IDENTIFIER_RE.test(schema) || !IDENTIFIER_RE.test(table)) {
      throw new BadRequestException(
        'Schema and table names must match [A-Za-z_][A-Za-z0-9_]{0,62}',
      );
    }
    const geomCol = layer.geometryColumn;
    if (!IDENTIFIER_RE.test(geomCol)) {
      throw new BadRequestException('Invalid geometry column');
    }
    // #158 Phase 1.5: when the table's geometry column is in a
    // non-WGS84 SRID, we reproject the bbox into that SRID on the
    // WHERE side (so the GiST index still bites) and reproject
    // the geometry to 4326 on the SELECT side (so the wire format
    // stays WGS84 GeoJSON). Tables already in 4326 take the
    // unchanged fast path.
    const srcSrid = layer.srid;
    const needsReproject = srcSrid !== 4326;
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.bbox) {
      const [minLng, minLat, maxLng, maxLat] = args.bbox;
      if (
        !isFiniteIn(minLng, -180, 180) ||
        !isFiniteIn(maxLng, -180, 180) ||
        !isFiniteIn(minLat, -90, 90) ||
        !isFiniteIn(maxLat, -90, 90)
      ) {
        throw new BadRequestException('bbox out of WGS84 range');
      }
      params.push(minLng, minLat, maxLng, maxLat);
      const envelope =
        `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, ` +
        `$${params.length - 1}, $${params.length}, 4326)`;
      const envelopeInSrcSrid = needsReproject
        ? `ST_Transform(${envelope}, ${srcSrid})`
        : envelope;
      where.push(`${quoteIdent(geomCol)} && ${envelopeInSrcSrid}`);
    }
    if (args.whereClause && args.whereClause.trim().length > 0) {
      const clause = args.whereClause.trim();
      if (WHERE_CLAUSE_BLOCKLIST.test(clause)) {
        throw new BadRequestException(
          'WHERE clause cannot contain `;`, comment markers, or block comments',
        );
      }
      if (clause.length > 2000) {
        throw new BadRequestException('WHERE clause is too long (max 2000 chars)');
      }
      where.push(`(${clause})`);
    }
    // #158 Phase 1.5: structured filter -> parameterized SQL.
    // Each clause goes through compileFilterClause, which only
    // ever emits placeholder `$N` references for values (never
    // inlines them) and validates field names against the layer's
    // column inventory so a clause can't reference a column we
    // don't know about.
    if (args.filter) {
      const allowed = new Set(layer.columns.map((c) => c.name));
      const compiled = compileFilter(args.filter, allowed, params.length);
      if (compiled) {
        where.push(`(${compiled.sql})`);
        params.push(...compiled.params);
      }
    }
    const limit = Math.min(args.limit ?? MAX_FEATURES_PER_REQUEST, MAX_FEATURES_PER_REQUEST);
    const attributeCols = layer.columns
      .filter((c) => IDENTIFIER_RE.test(c.name))
      .map((c) => `'${c.name}', ${quoteIdent(c.name)}`)
      .join(', ');
    const geomExpr = needsReproject
      ? `ST_Transform(${quoteIdent(geomCol)}, 4326)`
      : quoteIdent(geomCol);
    const sql =
      `SELECT json_build_object(
         'type', 'Feature',
         'geometry', ST_AsGeoJSON(${geomExpr})::json,
         'properties', json_build_object(${attributeCols || "'_', NULL"})
       ) AS feature
       FROM ${quoteIdent(schema)}.${quoteIdent(table)}` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` LIMIT $${params.length + 1}`;
    params.push(limit + 1);
    const pool = await this.getPool(serviceItemId, data);
    const client = await pool.connect();
    try {
      await client.query(
        `SET statement_timeout = ${data.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}`,
      );
      const res = await client.query<{ feature: unknown }>(sql, params);
      const truncated = res.rows.length > limit;
      const features = (truncated ? res.rows.slice(0, limit) : res.rows).map(
        (r) => r.feature,
      );
      return { type: 'FeatureCollection', features, truncated };
    } finally {
      client.release();
    }
  }

  /**
   * Test a connection without saving the service item. Used by
   * the create wizard's "Test connection" button so the author
   * gets a clean error before committing. On success also returns
   * a capped inventory of geometry tables in the default schema
   * so the wizard can preview what Save will register.
   */
  async testConnection(args: {
    host: string;
    port: number;
    database: string;
    role: string;
    password: string;
    defaultSchema?: string;
  }): Promise<
    | {
        ok: true;
        postgisVersion: string;
        schema: string;
        tables: PostgisTablePreview[];
        tablesTruncated: boolean;
        tableCount: number;
      }
    | { ok: false; error: string }
  > {
    if (!args.host || !args.database || !args.role) {
      return { ok: false, error: 'host, database, and role are required' };
    }
    const schema = args.defaultSchema?.trim() || 'public';
    if (!IDENTIFIER_RE.test(schema)) {
      return {
        ok: false,
        error:
          `Invalid schema name "${schema}". Schemas must match ` +
          `[A-Za-z_][A-Za-z0-9_]{0,62}.`,
      };
    }
    const port = Number.isFinite(args.port) && args.port > 0 ? args.port : 5432;
    const pool = new Pool({
      host: args.host,
      port,
      database: args.database,
      user: args.role,
      password: args.password,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 100,
    });
    try {
      const client = await pool.connect();
      try {
        await client.query(`SET statement_timeout = 5000`);
        const res = await client.query<{ v: string }>(
          `SELECT postgis_lib_version() AS v`,
        );
        const inventory = await listGeometryTablesPreview(
          client,
          schema,
          MAX_TEST_CONNECTION_TABLES,
        );
        return {
          ok: true,
          postgisVersion: res.rows[0]?.v ?? 'unknown',
          schema,
          tables: inventory.tables,
          tablesTruncated: inventory.truncated,
          tableCount: inventory.total,
        };
      } finally {
        client.release();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  // ---- helpers ---------------------------------------------------------

  private async loadService(user: AuthUser, serviceItemId: string) {
    const item = await this.prisma.item.findFirst({
      where: {
        id: serviceItemId,
        type: 'service',
        deletedAt: null,
      },
    });
    if (!item) throw new NotFoundException('Service item not found');
    const data = item.data as { protocol?: string } | null;
    if (data?.protocol !== 'postgis_live') {
      throw new BadRequestException(
        'This endpoint is only valid for postgis_live service items',
      );
    }
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: serviceItemId },
    });
    if (!this.sharing.canRead(user, item, shares)) {
      throw new NotFoundException('Service item not found');
    }
    return item;
  }

  private async getPool(
    itemId: string,
    data: PostgisLiveService,
  ): Promise<Pool> {
    const existing = this.pools.get(itemId);
    if (existing) return existing;
    const cred = await this.credentials
      .getCredentialForProxy(itemId)
      .catch(() => null);
    if (!cred || cred.kind !== 'basic') {
      throw new ForbiddenException(
        'No password stored for this service. Re-save with the test-connection wizard.',
      );
    }
    const pool = new Pool({
      host: data.host,
      port: data.port,
      database: data.database,
      user: data.role,
      password: cred.password,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      // Idle client errors are logged but don't propagate; the
      // next checkout will reopen the underlying connection.
      this.log.warn(`PG pool idle-client error: ${err.message}`);
    });
    this.pools.set(itemId, pool);
    return pool;
  }

  /**
   * Tear a pool down — called from item delete / update paths
   * so a renamed-host or removed service item doesn't keep idle
   * connections open. Best-effort; failures are swallowed.
   */
  async tearDownPool(itemId: string): Promise<void> {
    const existing = this.pools.get(itemId);
    if (!existing) return;
    this.pools.delete(itemId);
    await existing.end().catch(() => undefined);
  }
}

function quoteIdent(name: string): string {
  // SQL identifier quoting: wrap in double-quotes and escape any
  // embedded double-quote by doubling. IDENTIFIER_RE already
  // restricts the surface area, but we still quote for defense.
  return '"' + name.replace(/"/g, '""') + '"';
}

function splitTableName(name: string): [string, string] {
  const dot = name.indexOf('.');
  if (dot < 0) return ['public', name];
  return [name.slice(0, dot), name.slice(dot + 1)];
}

function isFiniteIn(n: unknown, min: number, max: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

/**
 * #158 Phase 1.5: compile a MapLayerFilter into a parameterized
 * SQL fragment.
 *
 *   - `clauses` are ANDed or ORed by `combinator` ('all' / 'any').
 *   - Field names get quoted-identifier treatment after a strict
 *     identifier-regex check AND a membership check against the
 *     `allowed` column inventory: a clause referencing a column
 *     the layer doesn't expose is rejected. This is the column-
 *     existence guarantee that keeps an author from snooping into
 *     a sibling table by typo.
 *   - User-supplied values ALWAYS go through `$N` placeholders.
 *     The function never inlines string values into the SQL.
 *   - Numeric comparison ops cast the placeholder via `::numeric`
 *     so a string column compared with `> 5` still compiles.
 *   - Returns null when no clauses are present (filter exists but
 *     is empty), so the caller can skip the AND seamlessly.
 *
 * `paramOffset` is the count of params already in the outer
 * query so placeholders pick up after those. Returns the SQL +
 * the params to append to the outer query's param array.
 */
export function compileFilter(
  filter: MapLayerFilter,
  allowed: Set<string>,
  paramOffset: number,
): { sql: string; params: unknown[] } | null {
  if (!filter || !Array.isArray(filter.clauses) || filter.clauses.length === 0) {
    return null;
  }
  const params: unknown[] = [];
  const fragments: string[] = [];
  for (const clause of filter.clauses) {
    const compiled = compileFilterClause(clause, allowed, paramOffset + params.length);
    if (!compiled) continue;
    fragments.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }
  if (fragments.length === 0) return null;
  const join = filter.combinator === 'any' ? ' OR ' : ' AND ';
  return { sql: fragments.join(join), params };
}

function compileFilterClause(
  clause: MapLayerFilterClause,
  allowed: Set<string>,
  paramOffset: number,
): { sql: string; params: unknown[] } | null {
  if (!clause.field || !IDENTIFIER_RE.test(clause.field)) return null;
  if (!allowed.has(clause.field)) {
    throw new BadRequestException(
      `Filter field "${clause.field}" is not a known column on this layer`,
    );
  }
  const col = quoteIdent(clause.field);
  const params: unknown[] = [];
  switch (clause.op) {
    case 'is-null':
      return { sql: `${col} IS NULL`, params };
    case 'is-not-null':
      return { sql: `${col} IS NOT NULL`, params };
    case '==':
    case '!=': {
      params.push(clause.value);
      const ph = `$${paramOffset + params.length}`;
      const sqlOp = clause.op === '==' ? '=' : '<>';
      return { sql: `${col} ${sqlOp} ${ph}`, params };
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const n = Number(clause.value);
      if (!Number.isFinite(n)) return null;
      params.push(n);
      const ph = `$${paramOffset + params.length}`;
      // Cast the column to numeric so a JSONB / text column whose
      // values parse as numbers still compares correctly. PostGIS
      // tables typically have native typed columns where this is
      // a no-op.
      return { sql: `(${col})::numeric ${clause.op} ${ph}::numeric`, params };
    }
    case 'contains': {
      // ILIKE with %-escaped value; client-supplied %s + _s are
      // escaped so the user can't broaden the match accidentally.
      const escaped = clause.value
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      params.push(`%${escaped}%`);
      const ph = `$${paramOffset + params.length}`;
      return { sql: `(${col})::text ILIKE ${ph}`, params };
    }
    default:
      return null;
  }
}
