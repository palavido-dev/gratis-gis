// SPDX-License-Identifier: AGPL-3.0-or-later
//
// syncVersion moves only inside the transaction that inserts the
// observation. These tests run the real service and engine against
// Postgres after the repo's migrations. The stock PostGIS image has
// no pg_partman binaries (the project image installs them). The
// partition migration's create_parent call is replaced here by the
// monthly partitions that call would create, from 2025-01 through
// six months past now. Every other migration file runs unchanged.
// The observation table is still PARTITION BY RANGE (tx_time) with
// the composite primary key the migration installs.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService, FeatureConflictException } from './features.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import type { SharingService } from '../items/sharing.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the syncVersion suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '10000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000002';
const ITEM = '10000000-0000-4000-8000-000000000003';
const LAYER = 'layer-sync';
const ENTITY = '10000000-0000-4000-8000-000000000004';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function rewritePartitionMigration(sql: string): string {
  const cut = sql.indexOf('SELECT partman.create_parent');
  const resume = sql.indexOf('-- 6. Move existing data');
  if (cut < 0 || resume < 0) {
    throw new Error('partition migration no longer has the partman markers');
  }
  const head = sql
    .slice(0, cut)
    .replace(/CREATE SCHEMA IF NOT EXISTS partman;\s*/g, '')
    .replace(/CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;\s*/g, '');
  const partitions = `
DO $$
DECLARE
  m date := DATE '2025-01-01';
  horizon date := (date_trunc('month', now()) + interval '6 months')::date;
BEGIN
  WHILE m < horizon LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF observation FOR VALUES FROM (%L) TO (%L)',
      'observation_p' || to_char(m, 'YYYYMM'),
      m::timestamptz,
      (m + interval '1 month')::date::timestamptz
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
`;
  return head + partitions + sql.slice(resume);
}

function applyMigrations(url: string): void {
  const root = join(__dirname, '../../prisma/migrations');
  const dirs = readdirSync(root)
    .filter((name) => name !== 'migration_lock.toml')
    .sort();
  for (const dir of dirs) {
    const file = join(root, dir, 'migration.sql');
    let sql = readFileSync(file, 'utf8');
    if (dir.startsWith('20260508081000')) sql = rewritePartitionMigration(sql);
    const result = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1'], {
      input: sql,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `migration ${dir} failed\n${result.stderr}\n${result.stdout}`,
      );
    }
  }
}

d('syncVersion commits with the observation on migrated PostGIS', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  let engine: DataLayerEngine;
  const occUrl = databaseUrl(TEST_URL!, 'gg_sync_occ');

  const user = {
    id: USER,
    orgId: ORG,
    username: 'sync-user',
  } as AuthUser;

  async function syncVersion(): Promise<number> {
    const row = await pool.query<{ data_json: { layers: Array<{ syncVersion?: number }> } }>(
      'SELECT data_json FROM item WHERE id = $1',
      [ITEM],
    );
    return row.rows[0]!.data_json.layers[0]!.syncVersion ?? 0;
  }

  async function observationCount(): Promise<number> {
    const row = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM observation WHERE entity = $1`,
      [ENTITY],
    );
    return Number(row.rows[0]!.n);
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query('DROP DATABASE IF EXISTS gg_sync_occ');
    await admin.query('CREATE DATABASE gg_sync_occ');
    await admin.end();
    applyMigrations(occUrl);
    pool = new Pool({ connectionString: occUrl, max: 6 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: occUrl, max: 6 }),
    });
    const prisma = prismaClient as unknown as PrismaService;
    const engineSvc = new EngineService(prisma);
    engine = new DataLayerEngine(
      engineSvc,
      prisma,
      { checkFeature: () => true } as unknown as LensPolicyService,
      new TileCacheService(),
    );
    service = new DataLayerFeaturesService(
      prisma,
      { notifySourceWrite: async () => undefined } as unknown as DerivedLayerCacheRefreshService,
      engine,
      { noteFeatureWrite: () => undefined } as unknown as ItemBboxRefreshService,
      { visibleWhere: () => ({}) } as unknown as SharingService,
      { principalForUserId: async () => null } as unknown as AuthSyncService,
    );
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'sync-org', 'Sync Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'sync-user', 'sync@example.test', 'Sync User', 'viewer')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Sync layer', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        USER,
        JSON.stringify({
          version: 3,
          layers: [
            {
              id: LAYER,
              syncVersion: 0,
              fields: [
                { name: 'value', type: 'number', label: 'Value', nullable: true },
                { name: 'doubled', type: 'number', label: 'Doubled', nullable: true },
              ],
            },
          ],
        }),
      ],
    );
    const part = await pool.query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE relname = 'observation'`,
    );
    if (part.rows[0]?.relkind !== 'p') {
      throw new Error('observation was not created as a partitioned table');
    }
  });

  afterAll(async () => {
    await prismaClient.$disconnect();
    await pool.end();
  });

  it('two writers from the same head: one edit, one conflict, cursor moves once', async () => {
    const created = await service.insertFeatures(
      ITEM,
      LAYER,
      [{
        globalId: ENTITY,
        geometry: { type: 'Point', coordinates: [-79.9, 38.9] },
        properties: { value: 1 },
      }],
      user,
    );
    expect(created.inserted).toBe(1);
    expect(await syncVersion()).toBe(1);
    const listed = await engine.listFeatures({ itemId: ITEM, layerId: LAYER, entity: ENTITY });
    const head = listed.features[0]?.properties._observation_id;
    expect(typeof head).toBe('string');

    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const point = { type: 'Point' as const, coordinates: [-79.9, 38.9] as [number, number] };
    const principal = { sub: USER, displayName: 'sync-user' };
    const first = engine.commitLayerSync(ITEM, LAYER, async ({ tx, source }) => {
      const written = await engine.writeFeatureUpdate(
        {
          itemId: ITEM,
          layerId: LAYER,
          globalId: ENTITY,
          principal,
          source,
          properties: { value: 2 },
          geometry: point,
          expectedHeadObservationId: head as string,
        },
        tx,
      );
      await hold;
      return { wrote: !('conflict' in written), value: written };
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = engine.commitLayerSync(ITEM, LAYER, async ({ tx, source }) => {
      const written = await engine.writeFeatureUpdate(
        {
          itemId: ITEM,
          layerId: LAYER,
          globalId: ENTITY,
          principal,
          source,
          properties: { value: 3 },
          geometry: point,
          expectedHeadObservationId: head as string,
        },
        tx,
      );
      return { wrote: !('conflict' in written), value: written };
    });
    release();
    const [winner, loser] = await Promise.all([first, second]);
    const won = winner.wrote ? winner : loser;
    const lost = winner.wrote ? loser : winner;
    expect(won.wrote).toBe(true);
    expect(lost.wrote).toBe(false);
    expect(await syncVersion()).toBe(2);
    expect(await observationCount()).toBe(2);
    const after = await engine.listFeatures({ itemId: ITEM, layerId: LAYER, entity: ENTITY });
    expect(after.features[0]?.properties.value).toBe(won === winner ? 2 : 3);
  });

  it('bulk calculate records the losing writer and does not bump again', async () => {
    const before = await syncVersion();
    const listed = await engine.listFeatures({ itemId: ITEM, layerId: LAYER, entity: ENTITY });
    const head = String(listed.features[0]?.properties._observation_id);
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const point = { type: 'Point' as const, coordinates: [-79.9, 38.9] as [number, number] };
    const principal = { sub: USER, displayName: 'sync-user' };
    const first = engine.commitLayerSync(ITEM, LAYER, async ({ tx, source }) => {
      const written = await engine.writeFeaturesUpdate(
        [{
          itemId: ITEM,
          layerId: LAYER,
          globalId: ENTITY,
          principal,
          source,
          properties: { value: 4, doubled: 8 },
          geometry: point,
          expectedHeadObservationId: head,
        }],
        tx,
      );
      await hold;
      return { wrote: written.applied.length > 0, value: written };
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = engine.commitLayerSync(ITEM, LAYER, async ({ tx, source }) => {
      const written = await engine.writeFeaturesUpdate(
        [{
          itemId: ITEM,
          layerId: LAYER,
          globalId: ENTITY,
          principal,
          source,
          properties: { value: 5, doubled: 10 },
          geometry: point,
          expectedHeadObservationId: head,
        }],
        tx,
      );
      return { wrote: written.applied.length > 0, value: written };
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    const lost = a.wrote ? b : a;
    expect(lost.wrote).toBe(false);
    expect(lost.value.conflicts).toHaveLength(1);
    expect(lost.value.conflicts[0]?.globalId).toBe(ENTITY);
    expect(await syncVersion()).toBe(before + 1);
    const calc = await service.calculateField({
      itemId: ITEM,
      layerId: LAYER,
      expression: '{{value}} * 2',
      outputName: 'doubled',
      outputType: 'number',
      scope: 'selection',
      selectedIds: [ENTITY],
      dryRun: false,
      user,
    });
    expect(calc.appliedRows).toBe(1);
    expect(calc.conflicts).toBe(0);
    expect(await syncVersion()).toBe(before + 2);
  });

  it('a retried create does not advance the cursor, and a thrown write rolls back', async () => {
    const versionBeforeRetry = await syncVersion();
    const rowsBefore = await observationCount();
    const again = await service.insertFeatures(
      ITEM,
      LAYER,
      [{
        globalId: ENTITY,
        geometry: { type: 'Point', coordinates: [-79.9, 38.9] },
        properties: { value: 1 },
      }],
      user,
    );
    expect(again.inserted).toBe(0);
    expect(again.deduplicated).toBe(1);
    expect(await syncVersion()).toBe(versionBeforeRetry);
    expect(await observationCount()).toBe(rowsBefore);

    const versionBeforeThrow = await syncVersion();
    await expect(
      engine.commitLayerSync(ITEM, LAYER, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await syncVersion()).toBe(versionBeforeThrow);
    expect(await observationCount()).toBe(rowsBefore);
  });

  it('a conflicting field update is a 409 and does not move the cursor', async () => {
    const listed = await engine.listFeatures({ itemId: ITEM, layerId: LAYER, entity: ENTITY });
    const head = String(listed.features[0]?.properties._observation_id);
    const version = await syncVersion();
    await expect(
      service.updateFeature(
        ITEM,
        LAYER,
        ENTITY,
        { properties: { value: 9 } },
        user,
        { baseObservationId: '00000000-0000-4000-8000-000000000099' },
      ),
    ).rejects.toBeInstanceOf(FeatureConflictException);
    expect(await syncVersion()).toBe(version);
    const ok = await service.updateFeature(
      ITEM,
      LAYER,
      ENTITY,
      { properties: { value: 9 } },
      user,
      { baseObservationId: head },
    );
    expect(ok.properties.value).toBe(9);
    expect(await syncVersion()).toBe(version + 1);
  });
});
