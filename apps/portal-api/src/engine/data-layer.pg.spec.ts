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

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
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

// CI sets REQUIRE_PG_SPECS=1 so this suite can never silently skip
// there. A describe.skip looks identical to a pass in the job
// summary, which is exactly how the void-column regression (#215)
// shipped: the suite that would have caught it "passed" by not
// running. Failing the module load makes the absence of a database
// loud.
if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the pg-backed '
    + 'engine suite would silently skip. Point TEST_DATABASE_URL at a '
    + 'throwaway PostGIS or unset REQUIRE_PG_SPECS.',
  );
}

jest.setTimeout(180_000);

/**
 * The engine talks to the database through the REAL PrismaClient with
 * the same @prisma/adapter-pg driver adapter prod runs, not through a
 * hand-rolled pg bridge. This is the point of the suite (#215): a
 * bridge that maps $queryRaw onto pg's own query() faithfully renders
 * the SQL but not the adapter's deserialization, and node-postgres
 * happily tolerates result shapes the adapter rejects. The concrete
 * case: pg_advisory_xact_lock() returns void, the adapter throws
 * UnsupportedNativeDataType on a void result column, and the old
 * bridge masked exactly that, so the engine's $queryRaw-on-void bug
 * shipped with this suite green. Same client, same adapter, same
 * failure surface as production.
 */
function adapterClient(url: string): {
  client: PrismaClient;
  prisma: PrismaService;
} {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 8 }),
  });
  // The engine types its handle as the Nest PrismaService, which is
  // PrismaClient plus lifecycle hooks the engine never calls.
  return { client, prisma: client as unknown as PrismaService };
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
 *  a dependency-free way to assert feature presence in a tile. The
 *  driver adapter returns bytea as Uint8Array rather than Buffer
 *  (the Prisma 7 bytea change), so normalize before searching:
 *  Uint8Array's own toString ignores encodings and would silently
 *  match nothing. */
function tileContains(mvt: Buffer | Uint8Array, entityId: string): boolean {
  return Buffer.from(mvt).toString('latin1').includes(entityId);
}

const PRINCIPAL = { sub: 'itest-user', displayName: 'ITest' };

d('observation-log read paths against real PostGIS', () => {
  let pool: Pool;
  let client: PrismaClient;
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
    // The pool is for test-side DDL and raw assertions only; the code
    // under test goes through the real driver adapter.
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    ({ client, prisma } = adapterClient(TEST_URL!));
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
    await client.$disconnect();
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

  /**
   * Share row-scope (#40) across every read path. Four of the eight v3
   * read endpoints used to drop `rowScope` on the floor, so a share
   * configured "own rows only" was enforced on /features and handed
   * the whole layer over through /features-page, /features-search,
   * /selection-extent and the MVT tile. The tile mattered most: it is
   * what the map renders from and it projects every declared field.
   *
   * The subtle half is WHOSE row it is. Ownership is decided by the
   * entity's `create` observation, so a feature stays yours after
   * someone else edits it. Filtering `author_sub` on the raw version
   * rows instead would fail in both directions at once: it would drop
   * your own feature the moment another grantee touched it, and leak
   * theirs the moment you touched it.
   */
  describe('scenario 7: row-scope narrows every read path (#40)', () => {
    const itemId = uuidv7();
    const layerId = 'layer-rowscope';
    const scope = dataLayerScope(itemId, layerId);
    const mine = uuidv7();
    const theirs = uuidv7();
    const ALICE = { sub: 'alice-sub', displayName: 'Alice' };
    const BOB = { sub: 'bob-sub', displayName: 'Bob' };
    const own = { userId: ALICE.sub };
    const NEAR: [number, number] = [HERE[0] + 0.001, HERE[1] + 0.001];

    async function seedAs(
      author: { sub: string; displayName: string },
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
        author,
        source: { kind: 'itest' },
        parents: [],
      });
    }

    beforeAll(async () => {
      await seedAs(ALICE, mine, 'create', { name: 'Alice feature' }, HERE);
      await seedAs(BOB, theirs, 'create', { name: 'Bob feature' }, NEAR);
      // Bob edits Alice's row. The latest observation on `mine` is now
      // authored by Bob, which is exactly the case a naive
      // author_sub-on-latest filter gets wrong.
      await seedAs(BOB, mine, 'update', { name: 'Alice feature v2' }, HERE);
    });

    it('unscoped reads still see both (the guard is opt-in)', async () => {
      const page = await makeEngine().pageFeatures({ itemId, layerId, limit: 100 });
      expect(page.features.map((f) => f.id).sort()).toEqual([mine, theirs].sort());
    });

    it('pageFeatures returns only rows the caller created', async () => {
      const page = await makeEngine().pageFeatures({
        itemId,
        layerId,
        limit: 100,
        ownRowsOnly: own,
      });
      expect(page.features.map((f) => f.id)).toEqual([mine]);
    });

    it('pageFeatures keeps the scope when a content filter is present', async () => {
      // pageFeatures has two query shapes; the content-filter branch
      // takes a different path through the CTE and must scope too.
      const page = await makeEngine().pageFeatures({
        itemId,
        layerId,
        limit: 100,
        bbox: IN_BBOX,
        ownRowsOnly: own,
      });
      expect(page.features.map((f) => f.id)).toEqual([mine]);
    });

    it('searchFeatures reaches the whole layer but only the caller rows', async () => {
      const all = await makeEngine().searchFeatures({
        itemId,
        layerId,
        q: 'feature',
        limit: 8,
      });
      expect(all.results.map((r) => r.id).sort()).toEqual([mine, theirs].sort());
      const scoped = await makeEngine().searchFeatures({
        itemId,
        layerId,
        q: 'feature',
        limit: 8,
        ownRowsOnly: own,
      });
      expect(scoped.results.map((r) => r.id)).toEqual([mine]);
    });

    it('selectionExtent ignores ids the caller does not own', async () => {
      // A bbox over someone else's rows leaks their location even
      // though it carries no attributes.
      const engine = makeEngine();
      const unscoped = await engine.selectionExtent({
        itemId,
        layerId,
        entityIds: [mine, theirs],
      });
      expect(unscoped).toEqual([HERE[0], HERE[1], NEAR[0], NEAR[1]]);
      const scoped = await engine.selectionExtent({
        itemId,
        layerId,
        entityIds: [mine, theirs],
        ownRowsOnly: own,
      });
      expect(scoped).toEqual([HERE[0], HERE[1], HERE[0], HERE[1]]);
      const noneOwned = await engine.selectionExtent({
        itemId,
        layerId,
        entityIds: [theirs],
        ownRowsOnly: own,
      });
      expect(noneOwned).toBeNull();
    });

    it('ownership follows the create observation, not the last editor', async () => {
      // `mine` was last edited by Bob. It must still be Alice's, and
      // must NOT become Bob's.
      const alice = await makeEngine().pageFeatures({
        itemId,
        layerId,
        limit: 100,
        ownRowsOnly: { userId: ALICE.sub },
      });
      expect(alice.features.map((f) => f.id)).toEqual([mine]);
      const bob = await makeEngine().pageFeatures({
        itemId,
        layerId,
        limit: 100,
        ownRowsOnly: { userId: BOB.sub },
      });
      expect(bob.features.map((f) => f.id)).toEqual([theirs]);
    });

    it('the MVT tile omits features the caller does not own', async () => {
      const { x, y } = tileFor(14, HERE[0], HERE[1]);
      const { mvt } = await makeEngine().mvtTile({
        itemId,
        layerId,
        z: 14,
        x,
        y,
        ownRowsOnly: own,
      });
      expect(tileContains(mvt, mine)).toBe(true);
      expect(tileContains(mvt, theirs)).toBe(false);
    });

    it('a warmed unscoped tile is never served to a row-scoped viewer', async () => {
      // The cache-poisoning case, and the reason optsFingerprint()
      // hashes ownRowsOnly. ONE engine, so both reads share a cache:
      // the unscoped request warms the slot first, exactly as an
      // ordinary viewer would before a scoped one arrives.
      const engine = makeEngine();
      const { x, y } = tileFor(14, HERE[0], HERE[1]);
      const { mvt: unscoped } = await engine.mvtTile({
        itemId,
        layerId,
        z: 14,
        x,
        y,
      });
      expect(tileContains(unscoped, theirs)).toBe(true);
      const { mvt: scoped } = await engine.mvtTile({
        itemId,
        layerId,
        z: 14,
        x,
        y,
        ownRowsOnly: own,
      });
      expect(tileContains(scoped, mine)).toBe(true);
      expect(tileContains(scoped, theirs)).toBe(false);
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

  // The HTTP feature read resumes a walk from outside the generator
  // (`?cursor=`), so `readFeaturePage` is the contract an external
  // script actually pages on. The trap it has to survive: a page can
  // legitimately contain zero live features and still have data behind
  // it. A client that stopped on an empty page would silently truncate,
  // which is the exact class of bug the un-paged endpoint had.
  describe('scenario 6: readFeaturePage across tombstones', () => {
    const itemId = uuidv7();
    const layerId = 'layer-1';
    const scope = dataLayerScope(itemId, layerId);
    // Sorted explicitly rather than trusting generation order: uuidv7
    // is time-ordered at millisecond resolution, and these five are
    // minted in the same millisecond, so their relative order comes
    // from the random tail. The keyset walks entity order, so the test
    // has to know it rather than assume it.
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()].sort();
    const [first, gone1, gone2, mid, last] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];

    beforeAll(async () => {
      for (const id of ids) {
        await seed(scope, id, 'create', { NAME: id.slice(0, 8) }, HERE);
      }
      // A CONTIGUOUS run of tombstones in the middle: with pageSize 1
      // this guarantees at least one page whose live set is empty but
      // which is not the end of the data.
      await seed(scope, gone1, 'delete', null, null);
      await seed(scope, gone2, 'delete', null, null);
    });

    it('walks every live feature exactly once at pageSize 1', async () => {
      const engine = makeEngine();
      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      for (;;) {
        const page = await engine.readFeaturePage({
          itemId,
          layerId,
          pageSize: 1,
          after,
        });
        pages += 1;
        seen.push(...page.features.map((f) => f.id));
        if (page.nextCursor === null) break;
        after = page.nextCursor;
        // Guard against a cursor that fails to advance.
        expect(pages).toBeLessThan(20);
      }
      expect(seen).toEqual([first, mid, last]);
    });

    it('reports more data behind a page that yielded nothing', async () => {
      const engine = makeEngine();
      // Land exactly on the first tombstone: page size 1 starting just
      // below it.
      const page = await engine.readFeaturePage({
        itemId,
        layerId,
        pageSize: 1,
        after: first,
      });
      expect(page.features).toEqual([]);
      // The whole point: empty page, more to come.
      expect(page.nextCursor).toBe(gone1);
    });

    it('agrees with iterateFeatures, which is built on it', async () => {
      const engine = makeEngine();
      const streamed: string[] = [];
      for await (const batch of engine.iterateFeatures({
        itemId,
        layerId,
        pageSize: 1,
      })) {
        streamed.push(...batch.map((f) => f.id));
      }
      expect(streamed).toEqual([first, mid, last]);
    });

    it('pins the snapshot: asOf is echoed and honoured', async () => {
      const engine = makeEngine();
      // Pinned on the suite's fake clock, not wall time: `seed` stamps
      // valid_from from that clock (2026-07-01 + a second per write),
      // so a real `new Date()` pin would sit far in ITS future and
      // every later write would still be visible. Taking a tick here
      // puts the pin strictly between the setup writes and the one
      // below.
      const pin = nextTs();
      const firstPage = await engine.readFeaturePage({
        itemId,
        layerId,
        pageSize: 2,
        asOf: pin,
      });
      expect(firstPage.asOf).toEqual(pin);

      // A feature created AFTER the pinned instant must not appear in
      // a later page of the same walk.
      const late = uuidv7();
      await seed(scope, late, 'create', { NAME: 'late' }, HERE);

      const seen: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await engine.readFeaturePage({
          itemId,
          layerId,
          pageSize: 2,
          asOf: firstPage.asOf,
          after,
        });
        seen.push(...page.features.map((f) => f.id));
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
      expect(seen).not.toContain(late);

      // Without the pin, the same walk sees it. This is why the HTTP
      // layer echoes asOf back to the caller.
      const unpinned = await engine.readFeaturePage({
        itemId,
        layerId,
        pageSize: 100,
      });
      expect(unpinned.features.map((f) => f.id)).toContain(late);
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

  describe('scenario 8: aggregates answer from live rows only (#29 f/u)', () => {
    const itemId = uuidv7();
    const layerId = 'layer-agg';
    const scope = dataLayerScope(itemId, layerId);
    const edited = uuidv7();
    const doomed = uuidv7();
    const steady = uuidv7();
    const moved = uuidv7();
    const ALICE = { sub: 'agg-alice', displayName: 'Alice' };
    const BOB = { sub: 'agg-bob', displayName: 'Bob' };

    async function seedAs(
      author: { sub: string; displayName: string },
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
        author,
        source: { kind: 'itest' },
        parents: [],
      });
    }

    beforeAll(async () => {
      // A layer with every shape that breaks a naive aggregate:
      // an edited entity (two versions), a deleted one (tombstone),
      // a plain live one, and one that moved out of the bbox.
      await seedAs(ALICE, edited, 'create', { STATUS: 'Open', ACRES: 10 }, HERE);
      await seedAs(ALICE, edited, 'update', { STATUS: 'Closed', ACRES: 12 }, HERE);
      await seedAs(BOB, doomed, 'create', { STATUS: 'Open', ACRES: 100 }, HERE);
      await seedAs(BOB, doomed, 'delete', null, null);
      await seedAs(BOB, steady, 'create', { STATUS: 'Closed', ACRES: 8 }, HERE);
      await seedAs(ALICE, moved, 'create', { STATUS: 'Closed', ACRES: 5 }, HERE);
      await seedAs(ALICE, moved, 'update', { STATUS: 'Closed', ACRES: 5 }, AWAY);
    });

    it('count is live entities, not observations', async () => {
      // Seven observations, three live entities. Aggregating the raw
      // log would say 7; counting pre-collapse with a tombstone
      // filter would say 4 (the deleted entity resurrects through its
      // surviving create row).
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
      });
      expect(out.groups).toHaveLength(1);
      expect(out.groups[0]!.values.count).toBe(3);
      expect(out.truncated).toBe(false);
    });

    it('group keys come from the latest version, so an edited-away value vanishes', async () => {
      // `edited` was Open and is now Closed. A pre-collapse group-by
      // would report Open: 2 and hand the dashboard a number that
      // exists nowhere in the current data.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        groupBy: ['STATUS'],
        aggs: [{ op: 'count', as: 'count' }],
      });
      const byStatus = Object.fromEntries(
        out.groups.map((g) => [g.key.STATUS, g.values.count]),
      );
      expect(byStatus).toEqual({ Closed: 3 });
      expect(byStatus.Open).toBeUndefined();
    });

    it('sum and avg read the latest values and skip the tombstoned row', async () => {
      // ACRES: edited 10 -> 12, steady 8, moved 5, doomed 100 deleted.
      // Live sum is 25; counting the old version would give 23 and
      // counting the deleted one would give 125.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [
          { op: 'sum', field: 'ACRES', as: 'sum' },
          { op: 'avg', field: 'ACRES', as: 'avg' },
          { op: 'min', field: 'ACRES', as: 'min' },
          { op: 'max', field: 'ACRES', as: 'max' },
        ],
      });
      const v = out.groups[0]!.values;
      expect(v.sum).toBe(25);
      expect(v.avg).toBeCloseTo(25 / 3, 6);
      expect(v.min).toBe(5);
      expect(v.max).toBe(12);
    });

    it('bbox filters on the latest geometry, not any historical one', async () => {
      // `moved` was created inside IN_BBOX and edited to AWAY. It must
      // count in AWAY_BBOX and NOT in IN_BBOX; the reverse is the
      // ghost-geometry bug this shape exists to prevent.
      const engine = makeEngine();
      const here = await engine.aggregateFeatures({
        itemId,
        layerId,
        bbox: IN_BBOX,
        aggs: [{ op: 'count', as: 'count' }],
      });
      expect(here.groups[0]!.values.count).toBe(2);
      const away = await engine.aggregateFeatures({
        itemId,
        layerId,
        bbox: AWAY_BBOX,
        aggs: [{ op: 'count', as: 'count' }],
      });
      expect(away.groups[0]!.values.count).toBe(1);
    });

    it('row scope narrows the aggregate the same way it narrows the rows', async () => {
      // The whole reason this endpoint is server-side: a share scoped
      // to own-rows must see its own count. Alice created `edited` and
      // `moved`; Bob created `steady` (and the deleted one).
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        ownRowsOnly: { userId: ALICE.sub },
      });
      expect(out.groups[0]!.values.count).toBe(2);
    });

    it('geo limit clips the aggregate', async () => {
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        geoLimit: {
          type: 'Polygon',
          coordinates: [
            [
              [AWAY_BBOX[0], AWAY_BBOX[1]],
              [AWAY_BBOX[2], AWAY_BBOX[1]],
              [AWAY_BBOX[2], AWAY_BBOX[3]],
              [AWAY_BBOX[0], AWAY_BBOX[3]],
              [AWAY_BBOX[0], AWAY_BBOX[1]],
            ],
          ],
        },
      });
      expect(out.groups[0]!.values.count).toBe(1);
    });

    it('an attribute filter matches the latest version, never a ghost', async () => {
      // The single most important property of this filter. `edited`
      // was Open and is now Closed; `doomed` was Open and is deleted.
      // Both still have an Open row in the log, so a predicate applied
      // before the latest-per-entity collapse reports two Open
      // features that do not exist. The answer is zero.
      const engine = makeEngine();
      const open = await engine.aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'STATUS', op: '==', value: 'Open' }],
        },
      });
      expect(open.groups[0]?.values.count ?? 0).toBe(0);

      const closed = await engine.aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'STATUS', op: '==', value: 'Closed' }],
        },
      });
      expect(closed.groups[0]!.values.count).toBe(3);
    });

    it('filters the measure as well as the count', async () => {
      // ACRES on the live rows: edited 12, steady 8, moved 5.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'sum', field: 'ACRES', as: 'sum' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'ACRES', op: '>', value: '6' }],
        },
      });
      expect(out.groups[0]!.values.sum).toBe(20);
    });

    it('combines clauses with all and any', async () => {
      const engine = makeEngine();
      const both = await engine.aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [
            { field: 'STATUS', op: '==', value: 'Closed' },
            { field: 'ACRES', op: '<', value: '9' },
          ],
        },
      });
      expect(both.groups[0]!.values.count).toBe(2);

      const either = await engine.aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'any',
          clauses: [
            { field: 'ACRES', op: '>=', value: '12' },
            { field: 'ACRES', op: '<=', value: '5' },
          ],
        },
      });
      expect(either.groups[0]!.values.count).toBe(2);
    });

    it('a numeric comparison skips rows whose value is not a number', async () => {
      // STATUS is text everywhere. Casting it would raise 22P02 and
      // fail the whole request; the guard makes those rows unknown,
      // and unknown does not satisfy a comparison.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'STATUS', op: '>', value: '0' }],
        },
      });
      expect(out.groups[0]?.values.count ?? 0).toBe(0);
    });

    it('!= keeps rows with no value recorded', async () => {
      // A reader asking for "not Open" means every row that is not
      // Open, including the ones with nothing recorded. Plain <> drops
      // them, because NULL <> 'Open' is NULL rather than true.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'MISSING_COL', op: '!=', value: 'Open' }],
        },
      });
      expect(out.groups[0]!.values.count).toBe(3);
    });

    it('contains treats a literal percent as a character, not a wildcard', async () => {
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        where: {
          combinator: 'all',
          clauses: [{ field: 'STATUS', op: 'contains', value: '%' }],
        },
      });
      expect(out.groups[0]?.values.count ?? 0).toBe(0);
    });

    it('stacks with bbox and row scope rather than replacing them', async () => {
      // A filtered dashboard on a share-limited layer has to apply
      // both. Alice owns `edited` (Closed, HERE) and `moved` (Closed,
      // AWAY); only `edited` is inside IN_BBOX.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'count', as: 'count' }],
        bbox: IN_BBOX,
        ownRowsOnly: { userId: ALICE.sub },
        where: {
          combinator: 'all',
          clauses: [{ field: 'STATUS', op: '==', value: 'Closed' }],
        },
      });
      expect(out.groups[0]!.values.count).toBe(1);
    });

    it('a non-numeric column aggregates to null instead of failing the request', async () => {
      // STATUS is text. A dashboard asking for sum(STATUS) is a
      // configuration mistake, but a 500 tells the viewer nothing;
      // null renders as "no data" and the widget stays up.
      const out = await makeEngine().aggregateFeatures({
        itemId,
        layerId,
        aggs: [{ op: 'sum', field: 'STATUS', as: 'sum' }],
      });
      expect(out.groups[0]!.values.sum).toBeNull();
    });

    it('caps group cardinality and says so, returning the biggest groups', async () => {
      const capItem = uuidv7();
      const capScope = dataLayerScope(capItem, layerId);
      // 5 distinct keys; one of them ("k0") has two features so it is
      // unambiguously the top group under the ORDER BY.
      for (let i = 0; i < 5; i += 1) {
        const ts = nextTs();
        await engineSvc.write({
          scope: capScope,
          entity: uuidv7(),
          kind: 'create',
          validFrom: ts,
          validTo: null,
          txTime: ts,
          attrs: { K: `k${i}` },
          geom: { type: 'Point', coordinates: HERE },
          author: ALICE,
          source: { kind: 'itest' },
          parents: [],
        });
      }
      const extra = nextTs();
      await engineSvc.write({
        scope: capScope,
        entity: uuidv7(),
        kind: 'create',
        validFrom: extra,
        validTo: null,
        txTime: extra,
        attrs: { K: 'k0' },
        geom: { type: 'Point', coordinates: HERE },
        author: ALICE,
        source: { kind: 'itest' },
        parents: [],
      });
      const out = await makeEngine().aggregateFeatures({
        itemId: capItem,
        layerId,
        groupBy: ['K'],
        aggs: [{ op: 'count', as: 'count' }],
        limit: 2,
      });
      expect(out.groups).toHaveLength(2);
      expect(out.truncated).toBe(true);
      // Truncation keeps the TOP groups, which is what makes the cap
      // defensible: "showing top 2" is honest, an arbitrary 2 is not.
      expect(out.groups[0]!.key.K).toBe('k0');
      expect(out.groups[0]!.values.count).toBe(2);
    });

    it('refuses an empty or oversized aggregate list', async () => {
      const engine = makeEngine();
      await expect(
        engine.aggregateFeatures({ itemId, layerId, aggs: [] }),
      ).rejects.toThrow(/between 1 and/);
      await expect(
        engine.aggregateFeatures({
          itemId,
          layerId,
          aggs: Array.from({ length: 9 }, (_, i) => ({
            op: 'count' as const,
            as: `c${i}`,
          })),
        }),
      ).rejects.toThrow(/between 1 and/);
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
