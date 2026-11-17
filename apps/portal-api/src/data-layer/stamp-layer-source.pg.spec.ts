// SPDX-License-Identifier: AGPL-3.0-or-later
//
// stampV3LayerSource against real Postgres after the repo's
// migrations. A second connection holds the item row lock the way
// commitLayerSync does, bumps syncVersion and commits while the stamp
// waits. The stamp must block on that lock and then patch only
// `source`, so the bumped cursor survives.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { stampV3LayerSource } from './stamp-layer-source.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the layer source stamp suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_stamp_source';
const ORG = '20000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-000000000002';
const ITEM = '20000000-0000-4000-8000-000000000003';
const LAYER = 'layer-stamp';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('stampV3LayerSource keeps a concurrent syncVersion bump', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  // Built in beforeAll: describe.skip still runs this body, and
  // new URL(undefined) would throw when TEST_DATABASE_URL is unset.
  let url = '';

  async function layer(): Promise<Record<string, unknown>> {
    const row = await pool.query<{ data_json: { layers: Array<Record<string, unknown>> } }>(
      'SELECT data_json FROM item WHERE id = $1',
      [ITEM],
    );
    return row.rows[0]!.data_json.layers[0]!;
  }

  beforeAll(async () => {
    url = databaseUrl(TEST_URL!, DB);
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 4 });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }) });
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'stamp-org', 'Stamp Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'stamp-user', 'stamp@example.test', 'Stamp User', 'viewer')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Stamp layer', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        USER,
        JSON.stringify({
          version: 3,
          layers: [{ id: LAYER, syncVersion: 4, featureCount: 3 }],
        }),
      ],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  it('waits for the row lock and writes only source', async () => {
    const holder = await pool.connect();
    let settled = false;
    let stamp: Promise<boolean> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT data_json FROM item WHERE id = $1::uuid FOR UPDATE', [ITEM]);

      stamp = stampV3LayerSource(prisma, ITEM, LAYER, {
        fileName: 'parcels.gpkg',
        format: 'api',
        sizeBytes: 10,
        importedAt: '2026-11-08T00:00:00.000Z',
        importedBy: USER,
        note: 'driver: GPKG',
        sourceSrs: null,
      });
      void stamp.finally(() => {
        settled = true;
      });

      // The stamp is now queued behind our lock. Prove it is waiting.
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const r = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
           WHERE datname = $1 AND wait_event_type = 'Lock'`,
          [DB],
        );
        waiting = Number(r.rows[0]!.n) > 0;
        if (!waiting) await new Promise((r2) => setTimeout(r2, 100));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);

      // Bump the cursor the way commitLayerSync does, then commit.
      await holder.query(
        `UPDATE item
         SET data_json = jsonb_set(data_json, '{layers,0,syncVersion}', '5'::jsonb)
         WHERE id = $1::uuid`,
        [ITEM],
      );
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      holder.release();
    }

    expect(await stamp).toBe(true);
    const after = await layer();
    expect(after.syncVersion).toBe(5);
    expect(after.featureCount).toBe(3);
    expect(after.source).toMatchObject({ fileName: 'parcels.gpkg', importedBy: USER });
  });
});
