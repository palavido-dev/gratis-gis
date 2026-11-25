// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FeatureServer's applyEdits writes through prepareEditBatch and
// commitEditPlans: one transaction across the layers of an item, all
// or nothing by default, under the caller's write scope, and refused
// when a feature changed between the read and the write.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { AuthUser, AuthSyncService } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from './features.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import type { SharingService } from '../items/sharing.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the edit batch suite would silently skip.');
}

jest.setTimeout(180_000);

const ORG = '25000000-0000-4000-8000-000000000001';
const ALICE = '25000000-0000-4000-8000-000000000002';
const BOB = '25000000-0000-4000-8000-000000000003';
const ITEM = '25000000-0000-4000-8000-000000000004';
const PTS = 'pts';
const NOTES = 'notes';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

const point = (x: number) => ({ type: 'Point', coordinates: [x, 1] }) as never;

d('FeatureServer edit batches', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  const DB = 'gg_edit_batch';
  const alice = { id: ALICE, orgId: ORG, username: 'alice' } as AuthUser;
  const bob = { id: BOB, orgId: ORG, username: 'bob' } as AuthUser;

  async function syncVersions(): Promise<Record<string, number>> {
    const r = await pool.query<{ data_json: { layers: Array<{ id: string; syncVersion?: number }> } }>(
      'SELECT data_json FROM item WHERE id = $1',
      [ITEM],
    );
    return Object.fromEntries(r.rows[0]!.data_json.layers.map((l) => [l.id, l.syncVersion ?? 0]));
  }
  async function current(layer: string): Promise<Map<string, Record<string, unknown>>> {
    const fc = await service.listFeatures(ITEM, layer, {});
    return new Map(fc.features.map((f) => [String(f.id), f.properties as Record<string, unknown>]));
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    const dbUrl = databaseUrl(TEST_URL!, DB);
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    prismaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }) });
    const prisma = prismaClient as unknown as PrismaService;
    const engine = new DataLayerEngine(new EngineService(prisma), prisma, new TileCacheService());
    service = new DataLayerFeaturesService(
      prisma,
      { notifySourceWrite: async () => undefined } as unknown as DerivedLayerCacheRefreshService,
      engine,
      { noteFeatureWrite: () => undefined } as unknown as ItemBboxRefreshService,
      { visibleWhere: () => ({}) } as unknown as SharingService,
      { principalForUserId: async () => null } as unknown as AuthSyncService,
    );
    await pool.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'edit-org', 'Edit Org')`, [ORG]);
    for (const [id, name] of [[ALICE, 'alice'], [BOB, 'bob']] as const) {
      await pool.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role) VALUES ($1, $2, $3, $4, $3, 'admin')`,
        [id, ORG, name, `${name}@example.test`],
      );
    }
    const fields = [
      { name: 'name', type: 'string', label: 'Name', nullable: true },
      { name: 'n', type: 'number', label: 'N', nullable: true },
    ];
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Edits', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        ALICE,
        JSON.stringify({
          version: 3,
          layers: [
            { id: PTS, geometryType: 'point', syncVersion: 0, fields },
            { id: NOTES, geometryType: null, syncVersion: 0, fields },
          ],
        }),
      ],
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('writes edits on two layers in one transaction', async () => {
    const seeded = await service.insertFeatures(ITEM, PTS, [{ geometry: point(1), properties: { name: 'a', n: 1 } }, { geometry: point(2), properties: { name: 'b', n: 2 } }], alice);
    const [a, b] = seeded.globalIds as [string, string];
    const before = await syncVersions();

    const p1 = await service.prepareEditBatch(ITEM, PTS, alice, {
      adds: [{ properties: { name: 'c', n: 3 }, geometry: point(3) }],
      updates: [{ globalId: a, properties: { n: 10 } }],
      deletes: [b],
    }, {});
    const p2 = await service.prepareEditBatch(ITEM, NOTES, alice, {
      adds: [{ properties: { name: 'note' }, geometry: null }],
      updates: [],
      deletes: [],
    }, { isTable: true });
    const [r1, r2] = await service.commitEditPlans(ITEM, alice, [p1, p2], true);
    expect(r1!.applied && r2!.applied).toBe(true);
    expect([...r1!.adds, ...r1!.updates, ...r1!.deletes].every((o) => o.ok)).toBe(true);

    const pts = await current(PTS);
    expect(pts.has(b)).toBe(false);
    expect(pts.get(a)).toMatchObject({ name: 'a', n: 10 });
    expect([...pts.values()].some((p) => p.name === 'c')).toBe(true);
    expect((await current(NOTES)).size).toBe(1);
    const after = await syncVersions();
    expect(after[PTS]).toBe(before[PTS]! + 1);
    expect(after[NOTES]).toBe(before[NOTES]! + 1);
  });

  it('writes nothing when one edit fails and rollback is on', async () => {
    const before = await current(PTS);
    const [someId] = [...before.keys()];
    const plan = await service.prepareEditBatch(ITEM, PTS, alice, {
      adds: [{ properties: { name: 'never', n: 'not a number' as never }, geometry: point(4) }],
      updates: [{ globalId: someId!, properties: { name: 'changed' } }],
      deletes: ['25000000-0000-7000-8000-000000009999'],
    }, {});
    const [r] = await service.commitEditPlans(ITEM, alice, [plan], true);
    expect(r!.applied).toBe(false);
    expect(r!.adds[0]).toMatchObject({ ok: false });
    expect(r!.deletes[0]).toMatchObject({ ok: false, code: 1019 });
    expect(r!.updates[0]).toMatchObject({ ok: false, message: expect.stringContaining('Not applied') });
    expect(await current(PTS)).toEqual(before);
  });

  it('writes what passes when rollback is off', async () => {
    const [someId] = [...(await current(PTS)).keys()];
    const plan = await service.prepareEditBatch(ITEM, PTS, alice, {
      adds: [],
      updates: [{ globalId: someId!, properties: { name: 'kept' } }],
      deletes: ['25000000-0000-7000-8000-000000009999'],
    }, {});
    const [r] = await service.commitEditPlans(ITEM, alice, [plan], false);
    expect(r!.updates[0]).toMatchObject({ ok: true });
    expect(r!.deletes[0]).toMatchObject({ ok: false, code: 1019 });
    expect((await current(PTS)).get(someId!)).toMatchObject({ name: 'kept' });
  });

  it('cannot reach a feature outside the caller write scope', async () => {
    const [someId] = [...(await current(PTS)).keys()];
    const plan = await service.prepareEditBatch(ITEM, PTS, bob, {
      adds: [],
      updates: [{ globalId: someId!, properties: { name: 'bob was here' } }],
      deletes: [],
    }, { shareScope: { ownRowsOnly: { userId: BOB } } });
    expect(plan.updates[0]).toMatchObject({ ok: false, code: 1019 });
  });

  it('refuses a feature changed after it was read', async () => {
    const [someId] = [...(await current(PTS)).keys()];
    const plan = await service.prepareEditBatch(ITEM, PTS, alice, {
      adds: [{ properties: { name: 'late' }, geometry: point(9) }],
      updates: [{ globalId: someId!, properties: { name: 'mine' } }],
      deletes: [],
    }, {});
    await service.updateFeature(ITEM, PTS, someId!, { properties: { name: 'theirs' } }, bob);
    const [r] = await service.commitEditPlans(ITEM, alice, [plan], true);
    expect(r!.applied).toBe(false);
    const now = await current(PTS);
    expect(now.get(someId!)).toMatchObject({ name: 'theirs' });
    expect([...now.values()].some((p) => p.name === 'late')).toBe(false);
  });
});
