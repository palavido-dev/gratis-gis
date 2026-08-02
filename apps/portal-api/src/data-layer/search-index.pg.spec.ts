// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search-index integration suite: proves on a real PostGIS 17 that
//
//   1. CREATE INDEX CONCURRENTLY is impossible on the partitioned
//      observation table (the documented reason the reconciler
//      mirrors the geocoder's plain CREATE INDEX instead),
//   2. reconcileItem materializes the per-searchable-field partial
//      trigram indexes and the planner serves the REAL
//      DataLayerEngine.searchFeatures SQL through them (BitmapOr +
//      Bitmap Index Scans, no scope scan) on a 50k-row layer,
//   3. results are byte-identical with and without the indexes
//      (an index must only accelerate, never change, the ghost-safe
//      candidate -> collapse -> recheck pipeline),
//   4. unmarking a field searchable drops its index, and
//   5. an invalid index tree (fabricated via CREATE INDEX ON ONLY,
//      the partitioned-table failure shape) is detected, dropped,
//      and rebuilt valid.
//
// Skipped unless TEST_DATABASE_URL is set, because it needs a live
// PostGIS (matching prod: postgis/postgis:17-3.5):
//
//   docker run -d --name ggpg -e POSTGRES_PASSWORD=gg \
//     -p 55432:5432 postgis/postgis:17-3.5
//   TEST_DATABASE_URL=postgres://postgres:gg@localhost:55432/postgres \
//     pnpm -C apps/portal-api test -- --testPathPatterns search-index.pg
//
// Runs in its OWN database (gg_search_idx_test, dropped + recreated
// per run) because jest runs spec files in parallel workers and the
// ghost-feature suite (engine/data-layer.pg.spec.ts) drops and
// reseeds an `observation` table of its own on the default database.
//
// The observation DDL mirrors the real migrations the same way that
// suite's does (20260508081000 column shape, composite PK, RANGE
// partitioning on tx_time), with TWO partitions so index propagation
// and per-partition planning are actually exercised.

import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { Prisma } from '@prisma/client';

import { DataLayerSearchIndexService } from './search-index.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { DataLayerLayerShape } from './tables.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

// Same guard as data-layer.pg.spec.ts: in CI (REQUIRE_PG_SPECS=1) a
// missing database must fail the job, not skip the suite. A skipped
// suite reads as green, which is how the #215 class of bug ships.
if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the pg-backed '
    + 'search-index suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB_NAME = 'gg_search_idx_test';

/**
 * Same Prisma-surface bridge the ghost-feature suite uses, plus a
 * query capture: the EXPLAIN assertions below replay the exact
 * parameterized text + values searchFeatures sent, so the plan we
 * assert on is the plan prod gets, not a hand-transcribed copy.
 */
function prismaBridge(q: Pool | PoolClient) {
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const bridge = {
    captured,
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const s = Prisma.sql(strings, ...values);
      captured.push({ text: s.text, values: s.values });
      const res = await q.query({ text: s.text, values: s.values });
      return res.rows;
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const s = Prisma.sql(strings, ...values);
      const res = await q.query({ text: s.text, values: s.values });
      return res.rowCount ?? 0;
    },
    async $queryRawUnsafe(text: string, ...values: unknown[]) {
      const res = await q.query({ text, values });
      return res.rows;
    },
    async $executeRawUnsafe(text: string, ...values: unknown[]) {
      const res = await q.query({ text, values });
      return res.rowCount ?? 0;
    },
  };
  return bridge as unknown as PrismaService & { captured: typeof captured };
}

const lensPolicyPassthrough = {
  checkFeature: () => true,
} as unknown as LensPolicyService;

d('per-searchable-field trigram indexes against real PostGIS', () => {
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaService & {
    captured: Array<{ text: string; values: unknown[] }>;
  };
  let svc: DataLayerSearchIndexService;
  let engine: DataLayerEngine;

  const itemId = randomUUID();
  const layerId = 'layer-1';
  const scope = `data_layer:${itemId}:${layerId}`;
  const ownerIdx = DataLayerSearchIndexService.indexName(scope, 'OWNER');
  const apnIdx = DataLayerSearchIndexService.indexName(scope, 'APN');

  const eHit = randomUUID();
  const eGhost = randomUUID();
  const eDeleted = randomUUID();

  const searchableLayer = (searchable: boolean): DataLayerLayerShape[] => [
    {
      id: layerId,
      geometryType: 'point',
      fields: [
        { name: 'OWNER', type: 'string', ...(searchable ? { searchable } : {}) },
        { name: 'APN', type: 'string', ...(searchable ? { searchable } : {}) },
        { name: 'NOTE', type: 'string' },
      ],
    },
  ];

  beforeAll(async () => {
    // Dedicated database per run: see the header comment.
    admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    const url = new URL(TEST_URL!);
    url.pathname = `/${DB_NAME}`;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    prisma = prismaBridge(pool);
    svc = new DataLayerSearchIndexService(prisma);
    engine = new DataLayerEngine(
      new EngineService(prisma),
      prisma,
      lensPolicyPassthrough,
      new TileCacheService(),
    );

    await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`
      CREATE TABLE observation (
        id           UUID        NOT NULL,
        tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
        valid_from   TIMESTAMPTZ NOT NULL,
        valid_to     TIMESTAMPTZ,
        scope        TEXT        NOT NULL,
        entity       UUID        NOT NULL,
        kind         TEXT        NOT NULL CHECK (
                       kind IN ('create','update','delete','derive','observe')
                     ),
        attrs        JSONB,
        geom         GEOMETRY(Geometry, 4326),
        cell         CHAR(15),
        author_sub   TEXT        NOT NULL,
        source       JSONB       NOT NULL,
        parents      UUID[]      NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, tx_time)
      ) PARTITION BY RANGE (tx_time)
    `);
    await pool.query(`
      CREATE TABLE observation_p_a PARTITION OF observation
        FOR VALUES FROM ('2020-01-01') TO ('2026-07-01')
    `);
    await pool.query(`
      CREATE TABLE observation_p_b PARTITION OF observation
        FOR VALUES FROM ('2026-07-01') TO ('2100-01-01')
    `);
    // Prod's standing index set (post-20260618120000): the plans we
    // assert on must be chosen against the same alternatives.
    await pool.query(
      `CREATE INDEX observation_geom_gix ON observation USING GIST (geom)`,
    );
    await pool.query(
      `CREATE INDEX observation_scope_entity_validfrom_idx
         ON observation (scope, entity, valid_from DESC)`,
    );
    await pool.query(
      `CREATE INDEX observation_attrs_gin
         ON observation USING GIN (attrs jsonb_path_ops)`,
    );
    await pool.query(
      `CREATE INDEX observation_tx_time_idx ON observation (tx_time DESC)`,
    );

    // 50k live entities split across both partitions, plus 20k rows
    // of another scope as cross-layer noise the partial indexes must
    // exclude. Bulk SQL instead of 50k engine writes purely for
    // seed speed; searchFeatures only reads.
    await pool.query(`
      INSERT INTO observation
        (id, tx_time, valid_from, scope, entity, kind, attrs, geom,
         author_sub, source)
      SELECT
        gen_random_uuid(),
        ts, ts, '${scope}', gen_random_uuid(), 'create',
        jsonb_build_object(
          'OWNER', 'Owner ' || md5(g::text),
          'APN', lpad(g::text, 9, '0'),
          'NOTE', 'lorem ipsum'
        ),
        ST_SetSRID(ST_MakePoint(-80 + (g % 1000) * 0.0001,
                                39 + (g / 1000) * 0.0001), 4326),
        'itest', '{}'::jsonb
      FROM (
        SELECT g,
               CASE WHEN g % 2 = 0
                 THEN TIMESTAMPTZ '2026-06-15 00:00:00Z' + (g || ' seconds')::interval
                 ELSE TIMESTAMPTZ '2026-07-15 00:00:00Z' + (g || ' seconds')::interval
               END AS ts
        FROM generate_series(1, 50000) g
      ) series
    `);
    await pool.query(`
      INSERT INTO observation
        (id, tx_time, valid_from, scope, entity, kind, attrs,
         author_sub, source)
      SELECT
        gen_random_uuid(),
        TIMESTAMPTZ '2026-06-01 00:00:00Z' + (g || ' seconds')::interval,
        TIMESTAMPTZ '2026-06-01 00:00:00Z' + (g || ' seconds')::interval,
        'data_layer:${randomUUID()}:other', gen_random_uuid(), 'create',
        jsonb_build_object('OWNER', 'Palavido Decoy ' || g),
        'itest', '{}'::jsonb
      FROM generate_series(1, 20000) g
    `);

    // Targeted history rows: the query text is 'Palavido'.
    //   eHit:     latest version matches            -> the one hit
    //   eGhost:   OLD version matches, latest not   -> excluded
    //   eDeleted: matched, then tombstoned          -> excluded
    // The trigram index feeds candidate discovery over ANY version,
    // so eGhost and eDeleted ARE index candidates; only the
    // collapse + recheck keeps them out. Identical results with and
    // without the index therefore proves the index changed nothing
    // about ghost handling.
    const seedRow = async (
      entity: string,
      kind: 'create' | 'update' | 'delete',
      attrs: Record<string, unknown> | null,
      at: string,
    ) => {
      await pool.query(
        `INSERT INTO observation
           (id, tx_time, valid_from, scope, entity, kind, attrs, geom,
            author_sub, source)
         VALUES ($1, $2, $2, $3, $4, $5, $6,
                 ST_SetSRID(ST_MakePoint(-79.9, 38.9), 4326),
                 'itest', '{}'::jsonb)`,
        [randomUUID(), at, scope, entity, kind, attrs],
      );
    };
    await seedRow(
      eHit,
      'create',
      { OWNER: 'Palavido Farms LLC', APN: '999000111' },
      '2026-07-20 00:00:00Z',
    );
    await seedRow(
      eGhost,
      'create',
      { OWNER: 'Palavido Ghost Ranch', APN: '999000222' },
      '2026-07-20 00:00:00Z',
    );
    await seedRow(
      eGhost,
      'update',
      { OWNER: 'Renamed Holdings', APN: '999000222' },
      '2026-07-21 00:00:00Z',
    );
    await seedRow(
      eDeleted,
      'create',
      { OWNER: 'Palavido Estate (gone)', APN: '999000333' },
      '2026-07-20 00:00:00Z',
    );
    await seedRow(eDeleted, 'delete', null, '2026-07-21 00:00:00Z');

    await pool.query(`ANALYZE observation`);
  });

  afterAll(async () => {
    await pool?.end();
    // Leave the database in place for post-mortem poking; the next
    // run drops it first.
    await admin?.end();
  });

  const search = () =>
    engine.searchFeatures({
      itemId,
      layerId,
      q: 'Palavido',
      fields: ['OWNER', 'APN'],
      limit: 10,
    });

  it('CREATE INDEX CONCURRENTLY is rejected on the partitioned observation table (why the reconciler does not use it)', async () => {
    await expect(
      pool.query(
        `CREATE INDEX CONCURRENTLY idx_cic_probe ON observation
           USING gin ((attrs->>'OWNER') gin_trgm_ops)
           WHERE scope = '${scope}'`,
      ),
    ).rejects.toThrow(/cannot create index on partitioned table/);
  });

  it('reconcileItem builds one valid partial index per searchable field, propagated to every partition', async () => {
    const res = await svc.reconcileItem(itemId, searchableLayer(true));
    expect(new Set(res.created)).toEqual(new Set([ownerIdx, apnIdx]));
    expect(res.dropped).toEqual([]);
    expect(res.skippedFields).toEqual([]);

    const rows = await pool.query(
      `SELECT c.relname, i.indisvalid,
              (SELECT count(*) FROM pg_inherits h WHERE h.inhparent = c.oid) AS children
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = ANY($1)
       ORDER BY c.relname`,
      [[ownerIdx, apnIdx]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.indisvalid).toBe(true);
      expect(Number(r.children)).toBe(2); // both partitions covered
    }

    // Second run is a no-op: kept, not recreated.
    const again = await svc.reconcileItem(itemId, searchableLayer(true));
    expect(again.created).toEqual([]);
    expect(new Set(again.kept)).toEqual(new Set([ownerIdx, apnIdx]));
  });

  it('the REAL searchFeatures SQL is served by the indexes: BitmapOr of Bitmap Index Scans, no scope scan', async () => {
    const out = await search();
    expect(out.results.map((r) => r.id)).toEqual([eHit]);
    expect(out.results[0]!.properties.OWNER).toBe('Palavido Farms LLC');
    expect(out.truncated).toBe(false);

    // Replay searchFeatures' exact parameterized statement under
    // EXPLAIN: same text, same $n values, so the plan is the one
    // prod's custom plan gets.
    const q = prisma.captured[prisma.captured.length - 1]!;
    expect(q.text).toContain('content_candidates');
    const explained = await pool.query({
      text: `EXPLAIN (COSTS OFF) ${q.text}`,
      values: q.values,
    });
    const plan = explained.rows
      .map((r) => r['QUERY PLAN'] as string)
      .join('\n');
    expect(plan).toMatch(/BitmapOr/);
    expect(plan).toMatch(/Bitmap Index Scan/);
    // Candidate discovery must not degrade to scanning the scope's
    // rows: no partition of observation may be seq-scanned anywhere
    // in this plan.
    expect(plan).not.toMatch(/Seq Scan on observation/);
  });

  it('results are identical without the indexes (drop-on-unsearchable path), and the scan comes back', async () => {
    const indexed = await search();

    // Unmark both fields: reconcile must drop both indexes.
    const res = await svc.reconcileItem(itemId, searchableLayer(false));
    expect(new Set(res.dropped)).toEqual(new Set([ownerIdx, apnIdx]));
    const left = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [[ownerIdx, apnIdx]],
    );
    expect(left.rows).toEqual([]);

    const unindexed = await search();
    expect(unindexed).toEqual(indexed);
    expect(unindexed.results.map((r) => r.id)).toEqual([eHit]);

    // And the plan degrades to the scan searchFeatures' docstring
    // warns about, proving the indexes were load-bearing above.
    const q = prisma.captured[prisma.captured.length - 1]!;
    const explained = await pool.query({
      text: `EXPLAIN (COSTS OFF) ${q.text}`,
      values: q.values,
    });
    const plan = explained.rows
      .map((r) => r['QUERY PLAN'] as string)
      .join('\n');
    expect(plan).toMatch(/Seq Scan on observation/);
  });

  it('detects an invalid index tree, drops it, and rebuilds it valid', async () => {
    // Fabricate the realistic invalid shape on a partitioned table:
    // a parent-only index that never had partition indexes attached
    // (what a crashed per-partition-CONCURRENTLY pass leaves).
    await pool.query(
      `CREATE INDEX "${ownerIdx}" ON ONLY observation
         USING gin ((attrs->>'OWNER') gin_trgm_ops)
         WHERE scope = '${scope}'`,
    );
    const before = await pool.query(
      `SELECT i.indisvalid FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = $1`,
      [ownerIdx],
    );
    expect(before.rows[0]!.indisvalid).toBe(false);

    const res = await svc.reconcileItem(itemId, searchableLayer(true));
    expect(res.droppedInvalid).toContain(ownerIdx);
    expect(res.created).toEqual(expect.arrayContaining([ownerIdx, apnIdx]));

    const after = await pool.query(
      `SELECT i.indisvalid,
              (SELECT count(*) FROM pg_inherits h WHERE h.inhparent = c.oid) AS children
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = $1`,
      [ownerIdx],
    );
    expect(after.rows[0]!.indisvalid).toBe(true);
    expect(Number(after.rows[0]!.children)).toBe(2);
  });
});
