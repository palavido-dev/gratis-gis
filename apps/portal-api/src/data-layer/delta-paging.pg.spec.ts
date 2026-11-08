// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance for the delta sync protocol (docs/sync-protocol.md).
// Runs the real service and engine against a migrated Postgres in its
// own database.
//
// - A single write batch shares one syncVersion. A batch larger than
//   the page must still page completely with the (since, after)
//   cursor, with no row skipped and none repeated.
// - Row scope is decided by the entity's create observation, so a
//   supervisor's edit or delete of a field worker's row reaches that
//   worker.
// - A geo limit is decided per entity: a feature moved out of the
//   clip arrives as a delete, and a feature never inside stays
//   invisible.

import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from './features.service.js';
import { DataLayerEngine, type DeltaChange } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import type { SharingService } from '../items/sharing.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the delta paging suite would silently skip.',
  );
}

jest.setTimeout(240_000);

const DB = 'gg_delta_paging';
const ORG = '40000000-0000-4000-8000-000000000001';
const WORKER = '40000000-0000-4000-8000-000000000002';
const SUPERVISOR = '40000000-0000-4000-8000-000000000005';
const ITEM = '40000000-0000-4000-8000-000000000003';
const BULK = 'layer-bulk';
const SCOPED = 'layer-scoped';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('delta sync protocol on migrated PostGIS', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  let engine: DataLayerEngine;
  // Built lazily: describe.skip still runs this body without a URL.
  let dbUrl = '';

  const worker = { id: WORKER, orgId: ORG, username: 'worker' } as AuthUser;
  const supervisor = { id: SUPERVISOR, orgId: ORG, username: 'boss' } as AuthUser;
  const point = (x: number, y = 0) => ({ type: 'Point' as const, coordinates: [x, y] as [number, number] });

  /** Walk every page the way a conforming client does. */
  async function walk(
    layerId: string,
    since: number,
    limit: number,
    opts: { ownRowsOnly?: boolean; userId?: string; geoLimit?: unknown } = {},
  ): Promise<{ changes: DeltaChange[]; head: number; pages: number }> {
    const changes: DeltaChange[] = [];
    let after: string | undefined;
    let cursor = since;
    for (let pages = 1; pages < 1000; pages += 1) {
      const body = await service.listDelta(ITEM, layerId, cursor, {
        limit,
        ...(after !== undefined ? { after } : {}),
        ...(opts.ownRowsOnly ? { ownRowsOnly: true, userId: opts.userId! } : {}),
        ...(opts.geoLimit !== undefined
          ? { geoLimit: opts.geoLimit as never }
          : {}),
      });
      changes.push(...body.changes);
      if (!body.truncated) return { changes, head: body.syncVersion, pages };
      expect(body.nextSince).toBe(body.changes[body.changes.length - 1]!.syncVersion);
      expect(body.nextAfter).toBe(body.changes[body.changes.length - 1]!.observationId);
      cursor = body.nextSince!;
      after = body.nextAfter!;
    }
    throw new Error('delta walk did not finish');
  }

  beforeAll(async () => {
    dbUrl = databaseUrl(TEST_URL!, DB);
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }),
    });
    const prisma = prismaClient as unknown as PrismaService;
    engine = new DataLayerEngine(
      new EngineService(prisma),
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
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'delta-org', 'Delta Org')`,
      [ORG],
    );
    for (const [id, name] of [[WORKER, 'worker'], [SUPERVISOR, 'boss']] as const) {
      await pool.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
         VALUES ($1, $2, $3, $4, $3, 'viewer')`,
        [id, ORG, name, `${name}@example.test`],
      );
    }
    const fields = [{ name: 'value', type: 'number', label: 'Value', nullable: true }];
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Delta layer', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        WORKER,
        JSON.stringify({
          version: 3,
          layers: [
            { id: BULK, syncVersion: 0, fields },
            { id: SCOPED, syncVersion: 0, fields },
          ],
        }),
      ],
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('pages a single-version import larger than the page completely', async () => {
    const big = Array.from({ length: 2_500 }, (_, i) => ({
      geometry: point(i / 100),
      properties: { value: i },
    }));
    const created = await service.insertFeatures(ITEM, BULK, big, worker);
    expect(created.inserted).toBe(2_500);
    // A second, smaller batch after the big one.
    await service.insertFeatures(
      ITEM,
      BULK,
      [{ geometry: point(99), properties: { value: -1 } }],
      worker,
    );

    const all = await walk(BULK, 0, 1_000);
    expect(all.pages).toBe(3);
    expect(all.head).toBe(2);
    expect(all.changes).toHaveLength(2_501);
    const ids = new Set(all.changes.map((c) => c.observationId));
    expect(ids.size).toBe(2_501);
    expect(new Set(all.changes.map((c) => c.entity)).size).toBe(2_501);
    expect(all.changes.slice(0, 2_500).every((c) => c.syncVersion === 1)).toBe(true);
    expect(all.changes[2_500]!.syncVersion).toBe(2);
    // Rows carry what a full read inlines.
    const first = all.changes[0]!;
    expect(first.createdBy).toBe(WORKER);
    expect(first.createdAt).toBe(first.txTime);

    // The old since-only walk (since = last.syncVersion) loses the
    // rest of version 1. This is the bug the cursor fixes.
    const page1 = await service.listDelta(ITEM, BULK, 0, { limit: 1_000 });
    expect(page1.truncated).toBe(true);
    const legacy = await service.listDelta(ITEM, BULK, page1.changes[999]!.syncVersion, {
      limit: 1_000,
    });
    expect(legacy.changes).toHaveLength(1);
  });

  it('refuses an after that is not a row of this layer at since', async () => {
    const page1 = await service.listDelta(ITEM, BULK, 0, { limit: 10 });
    await expect(
      service.listDelta(ITEM, BULK, 2, { limit: 10, after: page1.nextAfter! }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listDelta(ITEM, BULK, 1, {
        limit: 10,
        after: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('own rows: scope follows the create, so a supervisor edit and delete reach the worker', async () => {
    const mine = await service.insertFeatures(
      ITEM,
      SCOPED,
      [
        { geometry: point(1, 1), properties: { value: 1 } },
        { geometry: point(2, 2), properties: { value: 2 } },
      ],
      worker,
    );
    const theirs = await service.insertFeatures(
      ITEM,
      SCOPED,
      [{ geometry: point(3, 3), properties: { value: 3 } }],
      supervisor,
    );
    const [editMe, deleteMe] = mine.globalIds;
    const [theirRow] = theirs.globalIds;
    const seeded = (await service.listDelta(ITEM, SCOPED, 0, { limit: 1 })).syncVersion;

    const principal = { sub: SUPERVISOR, displayName: 'boss' };
    await engine.commitLayerSync(ITEM, SCOPED, async ({ tx, source }) => {
      await engine.writeFeatureUpdate(
        {
          itemId: ITEM,
          layerId: SCOPED,
          globalId: editMe!,
          principal,
          source,
          properties: { value: 10 },
          geometry: point(1, 1),
        },
        tx,
      );
      await engine.writeFeatureDelete(
        { itemId: ITEM, layerId: SCOPED, globalId: deleteMe!, principal, source },
        tx,
      );
      return { wrote: true, value: null };
    });
    // The worker edits the supervisor's row; that must not leak to
    // the worker's own-rows delta.
    await engine.commitLayerSync(ITEM, SCOPED, async ({ tx, source }) => {
      await engine.writeFeatureUpdate(
        {
          itemId: ITEM,
          layerId: SCOPED,
          globalId: theirRow!,
          principal: { sub: WORKER, displayName: 'worker' },
          source,
          properties: { value: 30 },
          geometry: point(3, 3),
        },
        tx,
      );
      return { wrote: true, value: null };
    });

    const own = await walk(SCOPED, seeded, 1_000, { ownRowsOnly: true, userId: WORKER });
    const byEntity = new Map(own.changes.map((c) => [c.entity, c]));
    expect(byEntity.get(editMe!)?.kind).toBe('update');
    expect(byEntity.get(editMe!)?.authorSub).toBe(SUPERVISOR);
    expect(byEntity.get(editMe!)?.createdBy).toBe(WORKER);
    expect(byEntity.get(deleteMe!)?.kind).toBe('delete');
    expect(byEntity.has(theirRow!)).toBe(false);
  });

  it('geo limit: a feature moved out of the clip arrives as a delete', async () => {
    const clip = {
      type: 'Polygon',
      coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]],
    };
    const made = await service.insertFeatures(
      ITEM,
      SCOPED,
      [
        { geometry: point(5, 5), properties: { value: 5 } },
        { geometry: point(50, 50), properties: { value: 50 } },
      ],
      worker,
    );
    const [moving, outsider] = made.globalIds;
    const seeded = (await service.listDelta(ITEM, SCOPED, 0, { limit: 1 })).syncVersion;
    const principal = { sub: SUPERVISOR, displayName: 'boss' };
    await engine.commitLayerSync(ITEM, SCOPED, async ({ tx, source }) => {
      for (const [globalId, x] of [[moving!, 60], [outsider!, 55]] as const) {
        await engine.writeFeatureUpdate(
          {
            itemId: ITEM,
            layerId: SCOPED,
            globalId,
            principal,
            source,
            properties: { value: x },
            geometry: point(x, x),
          },
          tx,
        );
      }
      return { wrote: true, value: null };
    });

    const clipped = await walk(SCOPED, seeded, 1_000, { geoLimit: clip });
    const rows = clipped.changes.filter((c) => c.entity === moving || c.entity === outsider);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity).toBe(moving);
    expect(rows[0]!.kind).toBe('delete');
    expect(rows[0]!.geometry).toBeNull();
    expect(rows[0]!.properties).toBeNull();
  });
});
