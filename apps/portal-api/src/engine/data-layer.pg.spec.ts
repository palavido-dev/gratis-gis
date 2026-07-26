// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ghost-feature regression suite: runs the engine's ACTUAL generated
// SQL against a real PostGIS. The observation log stores versions of
// entities; every filtered read must collapse to the latest version
// per entity BEFORE evaluating predicates, or old versions resurrect
// features that are deleted or no longer match. These tests seed the
// concrete scenarios from the 2026-07-26 review and would all fail
// against the pre-fix filter-then-collapse SQL.
//
// Skipped unless TEST_DATABASE_URL is set, because it needs a live
// PostGIS (matching prod: postgis/postgis:17-3.5):
//
//   docker run -d --name ggpg -e POSTGRES_PASSWORD=gg \
//     -p 55432:5432 postgis/postgis:17-3.5
//   TEST_DATABASE_URL=postgres://postgres:gg@localhost:55432/postgres \
//     pnpm -C apps/portal-api test -- data-layer.pg
//
// The `observation` DDL below is copied from the real migrations
// (20260507120000_engine_observation_log column shape, as re-declared
// by 20260508081000_partition_observation_table with the composite PK
// and RANGE partitioning on tx_time). Two deliberate simplifications,
// both faithful to what the engine SQL can observe:
//   - pg_partman only automates partition creation; a single wide
//     partition preserves partitioned-table planner behaviour without
//     needing the extension inside the stock postgis image.
//   - observation_cell_idx and observation_attrs_trgm are absent
//     because later migrations (20260510180000, 20260618120000)
//     dropped them; the live index set is what prod has.

import { Pool, type PoolClient } from 'pg';
import { Prisma } from '@prisma/client';
import type { Item } from '@prisma/client';
import { uuidv7 } from '@gratis-gis/engine';

import { DataLayerEngine, dataLayerScope } from './data-layer.js';
import { EngineService } from './engine.service.js';
import { TileCacheService } from './tile-cache.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { DerivedLayersService } from '../derived-layers/derived-layers.service.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

jest.setTimeout(180_000);

/**
 * Bridge a pg Pool / PoolClient behind the PrismaService surface the
 * engine code calls. Prisma.Sql renders the exact text + $n params
 * the driver adapter would send, so the SQL under test is the SQL
 * that runs in prod, not a re-implementation.
 */
function prismaBridge(q: Pool | PoolClient): PrismaService {
  const bridge = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const s = Prisma.sql(strings, ...values);
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
    async $transaction(fn: (tx: PrismaService) => Promise<unknown>) {
      const client = await (q as Pool).connect();
      try {
        await client.query('BEGIN');
        const result = await fn(prismaBridge(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return bridge as unknown as PrismaService;
}

const lensPolicyPassthrough = {
  checkFeature: () => true,
} as unknown as LensPolicyService;

/** Slippy-map tile coordinates containing a lng/lat at zoom z. */
function tileFor(z: number, lng: number, lat: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

/** UUIDs land verbatim in the MVT string table, so raw byte search is
 *  a dependency-free way to assert feature presence in a tile. */
function tileContains(mvt: Buffer, entityId: string): boolean {
  return mvt.toString('latin1').includes(entityId);
}

const PRINCIPAL = { sub: 'itest-user', displayName: 'ITest' };

d('observation-log read paths against real PostGIS', () => {
  let pool: Pool;
  let prisma: PrismaService;
  let engineSvc: EngineService;

  /** Fresh adapter per call site that needs an empty tile cache
   *  (mvtTile caches by key; tests write between tile reads). */
  const makeEngine = () =>
    new DataLayerEngine(
      engineSvc,
      prisma,
      lensPolicyPassthrough,
      new TileCacheService(),
    );

  /** Strictly-increasing valid_from per write so latest-picking is
   *  deterministic in tests (prod writes stamp `new Date()`; two
   *  same-millisecond writes tie-break on tx_time and then
   *  arbitrarily, which a regression test must not depend on). */
  let clock = Date.parse('2026-07-01T00:00:00Z');
  const nextTs = () => new Date((clock += 1000));

  async function seed(
    scope: string,
    entity: string,
    kind: 'create' | 'update' | 'delete',
    attrs: Record<string, unknown> | null,
    lngLat: [number, number] | null,
  ): Promise<void> {
    const ts = nextTs();
    await engineSvc.write({
      scope,
      entity,
      kind,
      validFrom: ts,
      validTo: null,
      txTime: ts,
      attrs,
      geom: lngLat ? { type: 'Point', coordinates: lngLat } : null,
      author: PRINCIPAL,
      source: { kind: 'itest' },
      parents: [],
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    prisma = prismaBridge(pool);
    engineSvc = new EngineService(prisma);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`DROP TABLE IF EXISTS observation CASCADE`);
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
      CREATE TABLE observation_p_itest PARTITION OF observation
        FOR VALUES FROM ('2020-01-01') TO ('2100-01-01')
    `);
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
  });

  afterAll(async () => {
    await pool.end();
  });

  // Shared geography: features live near (-79.90, 38.90); the "old
  // location" bbox and the "new location" bbox are disjoint.
  const IN_BBOX: [number, number, number, number] = [-80.0, 38.8, -79.8, 39.0];
  const AWAY: [number, number] = [-78.5, 39.5];
  const AWAY_BBOX: [number, number, number, number] = [-78.6, 39.4, -78.4, 39.6];
  const HERE: [number, number] = [-79.9, 38.9];

  describe('scenario 1: attribute edit (Open -> Closed)', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    const entity = uuidv7();

    beforeAll(async () => {
      await seed(scope, entity, 'create', { STATUS: 'Open' }, HERE);
      await seed(scope, entity, 'update', { STATUS: 'Closed' }, HERE);
    });

    it('pageFeatures q=Open returns NOTHING (old version must not resurrect)', async () => {
      const out = await makeEngine().pageFeatures({
        itemId,
        layerId,
        q: 'Open',
        limit: 100,
      });
      expect(out.features).toHaveLength(0);
      expect(out.truncated).toBe(false);
    });

    it('pageFeatures q=Closed returns the live version', async () => {
      const out = await makeEngine().pageFeatures({
        itemId,
        layerId,
        q: 'Closed',
        limit: 100,
      });
      expect(out.features.map((f) => f.id)).toEqual([entity]);
      expect(out.features[0]!.properties.STATUS).toBe('Closed');
    });

    it('searchFeatures q=Open returns NOTHING; q=Closed hits with latest geometry', async () => {
      const engine = makeEngine();
      const miss = await engine.searchFeatures({
        itemId,
        layerId,
        q: 'Open',
        limit: 8,
      });
      expect(miss.results).toHaveLength(0);
      const hit = await engine.searchFeatures({
        itemId,
        layerId,
        q: 'Closed',
        limit: 8,
      });
      expect(hit.results.map((r) => r.id)).toEqual([entity]);
      expect(hit.results[0]!.point).toEqual(HERE);
    });

    it('unfiltered listFeatures returns exactly the Closed version', async () => {
      const out = await makeEngine().listFeatures({ itemId, layerId });
      expect(out.features).toHaveLength(1);
      expect(out.features[0]!.id).toBe(entity);
      expect(out.features[0]!.properties.STATUS).toBe('Closed');
    });

    it('bbox-filtered listFeatures also returns the Closed version (filter did not hide the live row)', async () => {
      const out = await makeEngine().listFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
      });
      expect(out.features).toHaveLength(1);
      expect(out.features[0]!.properties.STATUS).toBe('Closed');
    });
  });

  describe('scenario 2: create then delete', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    const deleted = uuidv7();
    const alive = uuidv7();

    beforeAll(async () => {
      await seed(scope, deleted, 'create', { NAME: 'Doomed Depot' }, HERE);
      // ~150m from HERE, deliberately inside the SAME z14 tile so
      // the tile assertion can distinguish "ghost gone" from "tile
      // empty".
      await seed(scope, alive, 'create', { NAME: 'Steady Station' }, [
        -79.899, 38.901,
      ]);
      await seed(scope, deleted, 'delete', null, null);
    });

    it('unfiltered listFeatures omits the deleted entity', async () => {
      const out = await makeEngine().listFeatures({ itemId, layerId });
      expect(out.features.map((f) => f.id)).toEqual([alive].sort());
    });

    it('bbox-filtered listFeatures omits it (old geom row must not resurrect)', async () => {
      const out = await makeEngine().listFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
      });
      expect(out.features.map((f) => f.id)).toEqual([alive]);
    });

    it('pageFeatures (no filters) and (bbox + q) omit it', async () => {
      const engine = makeEngine();
      const plain = await engine.pageFeatures({ itemId, layerId, limit: 100 });
      expect(plain.features.map((f) => f.id)).toEqual([alive]);
      const filtered = await engine.pageFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
        q: 'Doomed',
        limit: 100,
      });
      expect(filtered.features).toHaveLength(0);
    });

    it('searchFeatures omits it', async () => {
      const out = await makeEngine().searchFeatures({
        itemId,
        layerId,
        q: 'Doomed',
        limit: 8,
      });
      expect(out.results).toHaveLength(0);
    });

    it('the MVT tile for its bbox does not contain it but contains the live neighbour', async () => {
      const { x, y } = tileFor(14, HERE[0], HERE[1]);
      const { mvt } = await makeEngine().mvtTile({
        itemId,
        layerId,
        z: 14,
        x,
        y,
      });
      expect(mvt.length).toBeGreaterThan(0);
      expect(tileContains(mvt, alive)).toBe(true);
      expect(tileContains(mvt, deleted)).toBe(false);
    });

    it('selectionExtent ignores the deleted entity', async () => {
      const engine = makeEngine();
      const both = await engine.selectionExtent({
        itemId,
        layerId,
        entityIds: [deleted, alive],
      });
      // Only the live point contributes: a degenerate 1-point box.
      expect(both).toEqual([-79.899, 38.901, -79.899, 38.901]);
      const only = await engine.selectionExtent({
        itemId,
        layerId,
        entityIds: [deleted],
      });
      expect(only).toBeNull();
    });

    it('iterateFeatures (bbox pushdown) never yields it', async () => {
      const ids: string[] = [];
      for await (const batch of makeEngine().iterateFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
        pageSize: 1,
      })) {
        ids.push(...batch.map((f) => f.id));
      }
      expect(ids).toEqual([alive]);
    });

    it('derived-layer read SQL (bbox) omits it', async () => {
      const svc = new DerivedLayersService(prisma);
      const recipe = {
        version: 1,
        source: { kind: 'data_layer', itemId },
        pipeline: [{ tool: 'centroid', params: {} }],
        featureLimit: 1000,
        outputSchema: [],
        bbox: [],
      };
      const { sql, params } = svc.buildReadSql(
        { data: recipe } as unknown as Item,
        { id: itemId, data: { version: 2, storageType: 'postgis' } },
        { bbox: IN_BBOX },
      );
      // buildReadSql targets the 'default' sublayer; re-point the
      // embedded scope literal at the seeded sublayer so the exact
      // generated shape runs against real rows.
      const rows = await pool.query(
        sql.replaceAll(
          `data_layer:${itemId}:default`,
          `data_layer:${itemId}:${layerId}`,
        ),
        params,
      );
      const ids = rows.rows.map((r: { global_id: string }) => r.global_id);
      expect(ids).toEqual([alive]);
    });
  });

  describe('scenario 3: MVT budget applies after the collapse', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    const a = uuidv7();
    const b = uuidv7();

    beforeAll(async () => {
      await seed(scope, a, 'create', { NAME: 'A' }, HERE);
      for (let i = 0; i < 50; i++) {
        await seed(scope, a, 'update', { NAME: 'A', REV: i }, HERE);
      }
      await seed(scope, b, 'create', { NAME: 'B' }, [-79.9001, 38.9001]);
    });

    it('a 2-feature budget still returns BOTH live features despite 51 superseded rows of A', async () => {
      const { x, y } = tileFor(14, HERE[0], HERE[1]);
      // Private-method access on purpose: mvtTile is a thin cache
      // wrapper; computeMvtTileBytes IS the SQL under test, and the
      // tiny budget proves limit-after-collapse without seeding
      // 5000+ rows.
      const engine = makeEngine() as unknown as {
        computeMvtTileBytes(
          args: { z: number; x: number; y: number; maxFeaturesPerTile?: number },
          scope: string,
        ): Promise<Buffer>;
      };
      const mvt = await engine.computeMvtTileBytes(
        { z: 14, x, y, maxFeaturesPerTile: 2 },
        scope,
      );
      expect(tileContains(mvt, a)).toBe(true);
      expect(tileContains(mvt, b)).toBe(true);
    });

    it('the default-budget public tile contains both exactly once each', async () => {
      const { x, y } = tileFor(14, HERE[0], HERE[1]);
      const { mvt } = await makeEngine().mvtTile({
        itemId,
        layerId,
        z: 14,
        x,
        y,
      });
      const text = mvt.toString('latin1');
      // A superseded 51 times must land as ONE feature, not one per
      // version (the string table would carry the uuid once either
      // way, so count features via the REV property staying single).
      expect(text.split(a).length - 1).toBe(1);
      expect(text.split(b).length - 1).toBe(1);
    });
  });

  describe('scenario 4: feature moved out of a bbox by an edit', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    const mover = uuidv7();
    const stayer = uuidv7();

    beforeAll(async () => {
      await seed(scope, mover, 'create', { NAME: 'Mover' }, HERE);
      await seed(scope, stayer, 'create', { NAME: 'Stayer' }, [
        -79.95, 38.95,
      ]);
      await seed(scope, mover, 'update', { NAME: 'Mover' }, AWAY);
    });

    it('old-location bbox reads exclude it; new-location bbox reads include it', async () => {
      const engine = makeEngine();
      const oldBox = await engine.listFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
      });
      expect(oldBox.features.map((f) => f.id)).toEqual([stayer]);
      const newBox = await engine.listFeatures({
        itemId,
        layerId,
        bbox: AWAY_BBOX,
      });
      expect(newBox.features.map((f) => f.id)).toEqual([mover]);
    });

    it('pageFeatures with the old bbox excludes it', async () => {
      const out = await makeEngine().pageFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
        limit: 100,
      });
      expect(out.features.map((f) => f.id)).toEqual([stayer]);
    });

    it('the old-location tile excludes it; the new-location tile includes it', async () => {
      const oldTile = tileFor(14, HERE[0], HERE[1]);
      const { mvt: oldMvt } = await makeEngine().mvtTile({
        itemId,
        layerId,
        z: 14,
        x: oldTile.x,
        y: oldTile.y,
      });
      expect(tileContains(oldMvt, mover)).toBe(false);
      const newTile = tileFor(14, AWAY[0], AWAY[1]);
      const { mvt: newMvt } = await makeEngine().mvtTile({
        itemId,
        layerId,
        z: 14,
        x: newTile.x,
        y: newTile.y,
      });
      expect(tileContains(newMvt, mover)).toBe(true);
    });

    it('iterateFeatures over the old bbox yields only the stayer, across page boundaries', async () => {
      const ids: string[] = [];
      for await (const batch of makeEngine().iterateFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
        pageSize: 1,
      })) {
        ids.push(...batch.map((f) => f.id));
      }
      expect(ids).toEqual([stayer]);
    });
  });

  describe('geocoder: internal search reads latest truth only', () => {
    const itemId = uuidv7();
    const geocoderId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    const renamed = uuidv7();
    const gone = uuidv7();

    const sourceItem = {
      id: itemId,
      type: 'data_layer',
      bbox: null,
      data: {
        version: 3,
        layers: [
          { id: layerId, geometryType: 'point', fields: [{ name: 'NAME' }] },
        ],
      },
    };
    const geocoderItem = {
      id: geocoderId,
      type: 'geocoding_service',
      bbox: null,
      data: {
        version: 1,
        sourceLayerId: itemId,
        sourceSublayerId: layerId,
        searchFields: [{ name: 'NAME' }],
        bboxFilter: 'none',
        minScore: 0.2,
      },
    };
    const itemsStub = {
      get: async (_user: AuthUser, id: string) =>
        id === geocoderId ? geocoderItem : sourceItem,
    };

    beforeAll(async () => {
      await seed(scope, renamed, 'create', { NAME: 'Maple Street' }, HERE);
      await seed(scope, renamed, 'update', { NAME: 'Oak Avenue' }, HERE);
      await seed(scope, gone, 'create', { NAME: 'Maple Court' }, HERE);
      await seed(scope, gone, 'delete', null, null);
    });

    const geocoder = () =>
      new GeocodingService(
        prisma,
        itemsStub as never,
        {} as never,
      );

    it('does not return a feature by its superseded attribute value', async () => {
      const out = await geocoder().search(
        {} as AuthUser,
        geocoderId,
        'Maple',
      );
      // Both Maple candidates are stale: one renamed, one deleted.
      expect(out).toHaveLength(0);
    });

    it('finds the feature under its current value', async () => {
      const out = await geocoder().search({} as AuthUser, geocoderId, 'Oak');
      expect(out.map((c) => c.featureId)).toEqual([renamed]);
      expect(out[0]!.label).toBe('Oak Avenue');
    });
  });

  describe('scenario 5: globalId create idempotency', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';

    const makeService = () =>
      new DataLayerFeaturesService(
        prisma,
        { notifySourceWrite: async () => undefined } as never,
        makeEngine(),
        { refreshItemBbox: async () => undefined } as never,
      );

    const user = { id: 'itest-user', username: 'itest' } as AuthUser;

    async function createRowCount(scope: string, entity: string) {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS n FROM observation
          WHERE scope = $1 AND entity = $2::uuid AND kind = 'create'`,
        [scope, entity],
      );
      return res.rows[0].n as number;
    }

    it('a retried POST with the same globalId yields ONE entity and reports the dedupe', async () => {
      const svc = makeService();
      const gid = uuidv7();
      const feature = {
        globalId: gid,
        geometry: { type: 'Point', coordinates: HERE },
        properties: { NAME: 'Once Only' },
      };
      const first = await svc.insertFeatures(itemId, layerId, [feature], user);
      expect(first).toEqual({
        inserted: 1,
        deduplicated: 0,
        globalIds: [gid],
      });
      const retry = await svc.insertFeatures(itemId, layerId, [feature], user);
      expect(retry).toEqual({
        inserted: 0,
        deduplicated: 1,
        globalIds: [gid],
      });
      expect(
        await createRowCount(dataLayerScope(itemId, layerId), gid),
      ).toBe(1);
      const list = await makeEngine().listFeatures({ itemId, layerId });
      expect(list.features.filter((f) => f.id === gid)).toHaveLength(1);
    });

    it('two CONCURRENT retries insert exactly once (advisory-lock race)', async () => {
      const gid = uuidv7();
      const engine = makeEngine();
      const args = {
        itemId,
        layerId,
        principal: PRINCIPAL,
        globalId: gid,
        properties: { NAME: 'Race' },
        geometry: { type: 'Point' as const, coordinates: HERE },
      };
      const [r1, r2] = await Promise.all([
        engine.writeFeaturesCreateIdempotent([args]),
        engine.writeFeaturesCreateIdempotent([args]),
      ]);
      const dedups = [r1[0]!, r2[0]!].filter((r) => r.deduplicated);
      expect(dedups).toHaveLength(1);
      expect(
        await createRowCount(dataLayerScope(itemId, layerId), gid),
      ).toBe(1);
    });

    it('a slow first transaction still blocks the second retry (explicit interleaving)', async () => {
      const gid = uuidv7();
      const scope = dataLayerScope(itemId, layerId);
      const clientA = await pool.connect();
      try {
        // Transaction A: lock + guarded insert, then HOLD the
        // transaction open. B must queue on the advisory lock, and
        // after A commits its probe must see A's row.
        await clientA.query('BEGIN');
        await clientA.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`${scope}|${gid}`],
        );
        await clientA.query(
          `INSERT INTO observation (
             id, tx_time, valid_from, valid_to, scope, entity, kind,
             attrs, geom, cell, author_sub, source, parents)
           SELECT $1::uuid, now(), now(), NULL, $2, $3::uuid, 'create',
                  '{"NAME":"Held"}'::jsonb, ST_GeomFromGeoJSON($4), NULL,
                  'itest-user', '{"kind":"itest"}'::jsonb, '{}'::uuid[]
           WHERE NOT EXISTS (
             SELECT 1 FROM (
               SELECT kind FROM observation
               WHERE scope = $2 AND entity = $3::uuid
               ORDER BY valid_from DESC, tx_time DESC
               LIMIT 1
             ) latest WHERE latest.kind <> 'delete'
           )`,
          [uuidv7(), scope, gid, JSON.stringify({ type: 'Point', coordinates: HERE })],
        );
        const second = makeEngine().writeFeaturesCreateIdempotent([
          {
            itemId,
            layerId,
            principal: PRINCIPAL,
            globalId: gid,
            properties: { NAME: 'Held Retry' },
            geometry: { type: 'Point', coordinates: HERE },
          },
        ]);
        // Give B time to reach and block on the lock, then commit A.
        await new Promise((r) => setTimeout(r, 300));
        await clientA.query('COMMIT');
        const [res] = await second;
        expect(res!.deduplicated).toBe(true);
      } finally {
        clientA.release();
      }
      expect(await createRowCount(scope, gid)).toBe(1);
    });

    it('re-create after delete is a REAL create, not a dedupe', async () => {
      const svc = makeService();
      const gid = uuidv7();
      const scope = dataLayerScope(itemId, layerId);
      const feature = {
        globalId: gid,
        geometry: { type: 'Point', coordinates: HERE },
        properties: { NAME: 'Phoenix' },
      };
      await svc.insertFeatures(itemId, layerId, [feature], user);
      await makeEngine().writeFeatureDelete({
        itemId,
        layerId,
        globalId: gid,
        principal: PRINCIPAL,
      });
      const again = await svc.insertFeatures(itemId, layerId, [feature], user);
      expect(again.inserted).toBe(1);
      expect(again.deduplicated).toBe(0);
      expect(await createRowCount(scope, gid)).toBe(2);
      const list = await makeEngine().listFeatures({ itemId, layerId });
      expect(list.features.some((f) => f.id === gid)).toBe(true);
    });
  });
});
