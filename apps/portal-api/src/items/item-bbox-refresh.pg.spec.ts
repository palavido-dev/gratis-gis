// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The bbox refresh's raw writes against real Postgres. Pins what a
 * mock cannot: the SQL union is computed from the row as stored, an
 * empty or short bbox is left for the full recompute, and neither
 * write moves updated_at.
 *
 * Runs in its own throwaway schema with a minimal copy of the item
 * columns the writes touch. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import { ItemBboxRefreshService } from './item-bbox-refresh.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the bbox refresh '
    + 'pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

type Writes = {
  writeBbox(id: string, bbox: number[] | null): Promise<void>;
  growStoredBbox(id: string, grew: number[]): Promise<number[] | null>;
};

d('bbox refresh raw writes against Postgres', () => {
  const schema = `gg_bbox_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;
  let svc: Writes;

  async function row(id: string): Promise<{ bbox: number[]; updated_at: Date }> {
    const r = await admin.query(
      `SELECT bbox, updated_at FROM ${schema}.item WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  async function insert(bbox: number[]): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO ${schema}.item (id, bbox, updated_at)
       VALUES ($1, $2, '2026-07-01 12:00:00')`,
      [id, bbox],
    );
    return id;
  }

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`
      CREATE TABLE ${schema}.item (
        id uuid PRIMARY KEY,
        bbox double precision[] NOT NULL DEFAULT '{}',
        updated_at timestamp(3) NOT NULL
      )
    `);
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }),
    });
    svc = new ItemBboxRefreshService(
      client as never,
      {} as never,
    ) as unknown as Writes;
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('grows from the stored bbox and returns the result', async () => {
    const id = await insert([0, 0, 10, 10]);
    await expect(svc.growStoredBbox(id, [-5, 2, 20, 3])).resolves.toEqual([
      -5, 0, 20, 10,
    ]);
    const r = await row(id);
    expect(r.bbox).toEqual([-5, 0, 20, 10]);
    expect(r.updated_at.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('returns null and writes nothing when there is no bbox to grow', async () => {
    const id = await insert([]);
    await expect(svc.growStoredBbox(id, [1, 1, 2, 2])).resolves.toBeNull();
    expect((await row(id)).bbox).toEqual([]);
  });

  it('writes and clears a bbox without moving updated_at', async () => {
    const id = await insert([0, 0, 1, 1]);
    await svc.writeBbox(id, [1, 2, 3, 4]);
    expect((await row(id)).bbox).toEqual([1, 2, 3, 4]);
    await svc.writeBbox(id, null);
    const r = await row(id);
    expect(r.bbox).toEqual([]);
    expect(r.updated_at.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });
});
