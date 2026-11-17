// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The items area search across the antimeridian (finding 45-8), run
 * against Postgres. A box from 170 to 190 used to miss an item stored
 * at -175. Runs in its own throwaway schema with the item columns the
 * statement touches. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import { ItemsService } from '../items/items.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the b15 pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

d('area search against Postgres', () => {
  const schema = `b15_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const org = randomUUID();
  let admin: PgClient;
  let client: PrismaClient;

  async function insert(bbox: number[]): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO ${schema}.item (id, type, access, bbox, org_id)
       VALUES ($1, 'map', 'private', $2, $3)`,
      [id, bbox, org],
    );
    return id;
  }

  async function idsIn(bbox: [number, number, number, number]): Promise<string[]> {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, { prisma: client, sharing: { visibleWhere: () => ({}) } });
    const where = (await (svc as unknown as {
      buildListWhere(u: unknown, o: unknown): Promise<{ AND: Array<{ id?: { in: string[] } }> }>;
    }).buildListWhere({ id: 'u', orgId: org }, { bbox }));
    return where.AND.find((c) => c.id)!.id!.in;
  }

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path = ${schema}, public`);
    await admin.query(
      `CREATE TYPE ${schema}."ItemType" AS ENUM ('map', 'data-layer',
        'arcgis-service', 'wms-service', 'wfs-service', 'geo-boundary')`,
    );
    await admin.query(`
      CREATE TABLE ${schema}.item (
        id uuid PRIMARY KEY,
        type ${schema}."ItemType" NOT NULL,
        access text NOT NULL,
        bbox double precision[] NOT NULL DEFAULT '{}',
        bbox_geom geometry(Polygon, 4326) GENERATED ALWAYS AS (
          CASE WHEN array_length(bbox, 1) = 4
            THEN ST_MakeEnvelope(bbox[1], bbox[2], bbox[3], bbox[4], 4326)
            ELSE NULL END
        ) STORED,
        org_id uuid,
        deleted_at timestamp(3)
      )
    `);
    await admin.query(`CREATE TABLE ${schema}.item_share (item_id uuid NOT NULL)`);
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('matches items on both sides of the antimeridian', async () => {
    const east = await insert([175, -18, 176, -17]);
    const west = await insert([-176, -18, -175, -17]);
    const far = await insert([0, 0, 1, 1]);
    const ids = await idsIn([170, -20, 190, -10]);
    expect(ids).toEqual(expect.arrayContaining([east, west]));
    expect(ids).not.toContain(far);
  });
});
