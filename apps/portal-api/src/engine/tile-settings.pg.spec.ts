// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-layer tile settings against a real PostGIS: the field selection
// and the feature cap change what ST_AsMVT emits, decoded rather than
// byte-searched so the assertion is about properties, not substrings.
//
// Runs in its OWN schema (search_path set on the connection), so it
// never touches the shared `observation` table other pg suites drop
// and recreate. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '@gratis-gis/engine';

import { DataLayerEngine, dataLayerScope } from './data-layer.js';
import { EngineService } from './engine.service.js';
import { TileCacheService } from './tile-cache.service.js';
import { decodeMvt } from '../testing/mvt-decode.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the tile settings suite would silently skip.',
  );
}

jest.setTimeout(120_000);

const SCHEMA = 'tile_settings_itest';

/** Slippy-map tile containing a lng/lat at zoom z. */
function tileFor(z: number, lng: number, lat: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

d('tile settings reach the tile bytes', () => {
  let pool: Pool;
  let client: PrismaClient;
  let prisma: PrismaService;
  let engineSvc: EngineService;
  const makeEngine = () =>
    new DataLayerEngine(
      engineSvc,
      prisma,
      { checkFeature: () => true } as unknown as LensPolicyService,
      new TileCacheService(),
    );

  const itemId = uuidv7();
  const layerId = 'parcels';
  const scope = dataLayerScope(itemId, layerId);
  const HERE: [number, number] = [-79.9, 38.9];
  const FIELDS = [
    { name: 'name', type: 'string' },
    { name: 'pop', type: 'number' },
    { name: 'zone', type: 'string' },
  ];
  const ids: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
    await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.observation (
        id           UUID        NOT NULL,
        tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
        valid_from   TIMESTAMPTZ NOT NULL,
        valid_to     TIMESTAMPTZ,
        scope        TEXT        NOT NULL,
        entity       UUID        NOT NULL,
        kind         TEXT        NOT NULL,
        attrs        JSONB,
        geom         public.GEOMETRY(Geometry, 4326),
        cell         CHAR(15),
        author_sub   TEXT        NOT NULL,
        source       JSONB       NOT NULL,
        parents      UUID[]      NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, tx_time)
      )
    `);
    client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: TEST_URL!,
        max: 4,
        options: `-c search_path=${SCHEMA},public`,
      }),
    });
    prisma = client as unknown as PrismaService;
    engineSvc = new EngineService(prisma);
    for (let i = 0; i < 5; i++) {
      const id = uuidv7();
      ids.push(id);
      await pool.query(
        `INSERT INTO ${SCHEMA}.observation
           (id, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
         VALUES ($1, now(), $2, $3, 'create', $4,
                 ST_SetSRID(ST_MakePoint($5, $6), 4326), 'itest', '{}')`,
        [
          uuidv7(),
          scope,
          id,
          JSON.stringify({ name: `n${i}`, pop: String(i * 10), zone: 'R1' }),
          HERE[0] + i * 0.0001,
          HERE[1],
        ],
      );
    }
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  const at = () => ({ itemId, layerId, z: 14, ...tileFor(14, HERE[0], HERE[1]) });

  it('carries every declared field by default', async () => {
    const { mvt } = await makeEngine().mvtTile({ ...at(), fields: FIELDS });
    const [layer] = decodeMvt(mvt);
    expect(layer!.name).toBe('features');
    expect(layer!.features).toHaveLength(5);
    expect(Object.keys(layer!.features[0]!.properties).sort()).toEqual([
      '_global_id',
      'name',
      'pop',
      'zone',
    ]);
  });

  it('carries only the selected fields', async () => {
    const { mvt } = await makeEngine().mvtTile({
      ...at(),
      fields: [FIELDS[0]!],
    });
    const [layer] = decodeMvt(mvt);
    for (const f of layer!.features) {
      expect(Object.keys(f.properties).sort()).toEqual(['_global_id', 'name']);
    }
  });

  it('honours a lowered feature cap and clamps a raised one', async () => {
    const engine = makeEngine();
    const capped = decodeMvt((await engine.mvtTile({ ...at(), maxFeaturesPerTile: 2 })).mvt);
    expect(capped[0]!.features).toHaveLength(2);
    // Above the ceiling is clamped, not refused: all five come back.
    const raised = decodeMvt((await engine.mvtTile({ ...at(), maxFeaturesPerTile: 1e9 })).mvt);
    expect(raised[0]!.features).toHaveLength(5);
  });

  it('stores tiles with different settings under different cache keys', async () => {
    const engine = makeEngine();
    const all = await engine.mvtTile({ ...at(), fields: FIELDS });
    const some = await engine.mvtTile({ ...at(), fields: [FIELDS[0]!] });
    expect(some.etag).not.toBe(all.etag);
    expect(Buffer.compare(all.mvt, some.mvt)).not.toBe(0);
  });
});
