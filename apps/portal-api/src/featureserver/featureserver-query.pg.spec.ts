// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SQL behind FeatureServer queries, against a real database: the
// current version of each feature only, deletes dropped, every clip
// applied, paging in ObjectID order, and the counts, ids, extents and
// statistics that Pro asks for answering from the same rows.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { esriSchema } from './esri-fields.js';
import { parseEsriQuery, type RawParams } from './esri-query-params.js';
import { FeatureOidService } from './feature-oid.service.js';
import { FeatureServerQueryService, type QueryLayer } from './featureserver-query.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the FeatureServer query suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ITEM = '24000000-0000-4000-8000-000000000003';
const SCOPE = `data_layer:${ITEM}:pts`;
const E = (n: number) => `24000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ALICE = 'alice-sub';
const BOB = 'bob-sub';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

const schema = esriSchema([
  { name: 'status', type: 'string' },
  { name: 'n', type: 'number' },
  { name: 'seen', type: 'date' },
]);

d('FeatureServer queries', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let svc: FeatureServerQueryService;
  const dbName = 'gg_featureserver_query';
  const dbUrl = databaseUrl(TEST_URL!, dbName);
  let seq = 0;
  let clock = Date.UTC(2026, 0, 1);

  async function write(
    entity: string,
    kind: string,
    attrs: Record<string, unknown>,
    lonLat: [number, number] | null,
    author = ALICE,
  ): Promise<void> {
    seq += 1;
    clock += 60_000;
    const at = new Date(clock).toISOString();
    await pool.query(
      `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
       VALUES ($1, $2, $2, $3, $4, $5, $6::jsonb,
               CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326) END,
               $9, '{}'::jsonb)`,
      [
        `24000000-0000-7000-9000-${String(seq).padStart(12, '0')}`,
        at,
        SCOPE,
        entity,
        kind,
        JSON.stringify(attrs),
        lonLat?.[0] ?? null,
        lonLat?.[1] ?? null,
        author,
      ],
    );
  }

  const layer = (extra: Partial<QueryLayer> = {}): QueryLayer => ({
    scope: SCOPE,
    geometryType: 'esriGeometryPoint',
    schema,
    ...extra,
  });
  const q = (p: RawParams) => parseEsriQuery(p, schema, false);
  const oidOf = async (entity: string): Promise<number> =>
    Number((await pool.query(`SELECT oid FROM feature_oid WHERE entity = $1`, [entity])).rows[0].oid);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prismaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }) });
    const prisma = prismaClient as unknown as PrismaService;
    const oids = new FeatureOidService(prisma, { shouldRun: () => true } as unknown as LeaderElectionService);
    svc = new FeatureServerQueryService(prisma, oids);

    await write(E(1), 'create', { status: 'open', n: 1, seen: '2026-01-05' }, [-79.85, 38.92]);
    await write(E(2), 'create', { status: 'closed', n: 2 }, [-79.84, 38.93]);
    await write(E(3), 'create', { status: 'open', n: 3 }, [10, 50], BOB);
    await write(E(4), 'create', { status: 'open', n: 4 }, [-79.83, 38.94]);
    // Edited out of "open": its old version must not match.
    await write(E(4), 'update', { status: 'closed', n: 4 }, [-79.83, 38.94]);
    // Deleted: gone from every answer.
    await write(E(5), 'create', { status: 'open', n: 5 }, [-79.82, 38.95]);
    await write(E(5), 'delete', {}, null);
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('pages current features in ObjectID order', async () => {
    const first = await svc.features(layer(), q({ outFields: '*', resultRecordCount: '2' }));
    expect(first.exceeded).toBe(true);
    expect(first.rows.map((r) => r.attributes.status)).toEqual(['open', 'closed']);
    expect(first.rows[0]!.attributes.GlobalID).toBe(`{${E(1).toUpperCase()}}`);
    expect(first.rows[0]!.attributes.seen).toBe(Date.UTC(2026, 0, 5));
    expect(first.rows[0]!.geometry).toEqual({ x: -79.85, y: 38.92 });
    const rest = await svc.features(layer(), q({ outFields: 'n', resultOffset: '2', resultRecordCount: '2' }));
    expect(rest.exceeded).toBe(false);
    expect(rest.rows.map((r) => r.attributes.n)).toEqual([3, 4]);
  });

  it('filters on the current version only', async () => {
    const ids = await svc.ids(layer(), q({ where: "status = 'open'" }));
    expect(ids).toEqual([await oidOf(E(1)), await oidOf(E(3))]);
    expect(await svc.count(layer(), q({ where: "status <> 'open' AND n BETWEEN 2 AND 9" }))).toBe(2);
    expect(await svc.count(layer(), q({ where: "UPPER(status) LIKE 'CLO%'" }))).toBe(2);
    expect(await svc.count(layer(), q({ where: 'seen IS NULL' }))).toBe(3);
    expect(await svc.count(layer(), q({ where: "seen >= DATE '2026-01-01'" }))).toBe(1);
  });

  it('narrows to objectIds and to a geometry', async () => {
    const two = await oidOf(E(2));
    expect(await svc.ids(layer(), q({ objectIds: `${two},999999999` }))).toEqual([two]);
    const box = '{"xmin":-80,"ymin":38,"xmax":-79,"ymax":39,"spatialReference":{"wkid":4326}}';
    expect(await svc.count(layer(), q({ geometry: box }))).toBe(3);
    // The same box in Web Mercator.
    const merc = '{"xmin":-8905560,"ymin":4579425,"xmax":-8794239,"ymax":4721671,"spatialReference":{"wkid":102100}}';
    expect(await svc.count(layer(), q({ geometry: merc }))).toBe(3);
  });

  it('applies the caller clips on every kind of query', async () => {
    const own = layer({ ownRowsOnly: { userId: BOB } });
    expect(await svc.count(own, q({}))).toBe(1);
    const clipped = layer({
      geoLimit: { type: 'Polygon', coordinates: [[[0, 40], [20, 40], [20, 60], [0, 60], [0, 40]]] },
    });
    expect(await svc.ids(clipped, q({}))).toEqual([await oidOf(E(3))]);
    const stats = await svc.statistics(
      clipped,
      q({ outStatistics: '[{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"c"}]' }),
      q({ outStatistics: '[{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"c"}]' }).statistics!,
    );
    expect(stats).toEqual([{ c: 1 }]);
  });

  it('answers extents, statistics and distinct values', async () => {
    const e = await svc.extent(layer(), q({ where: "status = 'closed'" }));
    expect(e!.xmin).toBeCloseTo(-79.84, 5);
    expect(e!.ymin).toBeCloseTo(38.93, 5);
    expect(e!.xmax).toBeCloseTo(-79.83, 5);
    expect(e!.ymax).toBeCloseTo(38.94, 5);
    const merc = await svc.extent(layer(), q({ where: "status = 'closed'", outSR: '102100' }));
    expect(Math.abs(merc!.xmin - -8887748)).toBeLessThan(2);

    const sq = q({
      outStatistics:
        '[{"statisticType":"sum","onStatisticField":"n","outStatisticFieldName":"total"},' +
        '{"statisticType":"max","onStatisticField":"status","outStatisticFieldName":"top"}]',
      groupByFieldsForStatistics: 'status',
    });
    expect(await svc.statistics(layer(), sq, sq.statistics!)).toEqual([
      { status: 'closed', total: 6, top: 'closed' },
      { status: 'open', total: 4, top: 'open' },
    ]);

    const dq = q({ outFields: 'status', returnDistinctValues: 'true' });
    expect((await svc.distinct(layer(), dq)).rows).toEqual([{ status: 'closed' }, { status: 'open' }]);
  });

  it('returns geometry in the requested spatial reference', async () => {
    const page = await svc.features(layer(), q({ objectIds: String(await oidOf(E(1))), outSR: '3857' }));
    const g = page.rows[0]!.geometry as { x: number; y: number };
    expect(Math.abs(g.x - -8888861.34)).toBeLessThan(0.01);
    expect(Math.abs(g.y - 4710218.73)).toBeLessThan(0.01);
  });
});
