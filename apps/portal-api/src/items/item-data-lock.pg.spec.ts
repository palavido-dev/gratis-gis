// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The item row lock against real Postgres, through the real Prisma
 * driver adapter. Pins two things a mock cannot:
 *   - two read-modify-write callers on the same row serialize, so
 *     neither loses the other's change;
 *   - `updatedAtMs` equals what Prisma's DateTime reads for the same
 *     timestamp(3) column, because update() compares the two.
 *
 * Runs in its own throwaway schema with a minimal copy of the item
 * columns the helper reads. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import { lockItemRow, withLockedItem } from './item-data-lock.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the item lock '
    + 'pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

d('item row lock against Postgres', () => {
  const schema = `gg_item_lock_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;
  const id = randomUUID();

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`
      CREATE TABLE ${schema}.item (
        id uuid PRIMARY KEY,
        data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamp(3) NOT NULL
      )
    `);
    await admin.query(
      `INSERT INTO ${schema}.item (id, data_json, updated_at)
       VALUES ($1, '{"n": 0}', '2026-07-01 12:00:00.123')`,
      [id],
    );
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('reports updated_at in the same epoch milliseconds Prisma uses', async () => {
    const row = await client.$transaction((tx) => lockItemRow(tx, id));
    expect(row?.updatedAtMs).toBe(Date.UTC(2026, 6, 1, 12, 0, 0, 123));
    expect(row?.data).toEqual({ n: 0 });
  });

  it('returns null for a missing row', async () => {
    await expect(
      client.$transaction((tx) => lockItemRow(tx, randomUUID())),
    ).resolves.toBeNull();
  });

  it('serializes concurrent read-modify-write callers', async () => {
    const bump = () =>
      withLockedItem(client, id, async (tx, row) => {
        const n = (row?.data as { n: number }).n;
        // Give the other caller time to read if the lock did not hold.
        await new Promise((r) => setTimeout(r, 150));
        await tx.$executeRaw`
          UPDATE item SET data_json = jsonb_build_object('n', ${n + 1}::int)
          WHERE id = ${id}::uuid
        `;
      });
    await Promise.all([bump(), bump(), bump()]);
    const { rows } = await admin.query(
      `SELECT data_json FROM ${schema}.item WHERE id = $1`,
      [id],
    );
    expect(rows[0].data_json).toEqual({ n: 3 });
  });
});
