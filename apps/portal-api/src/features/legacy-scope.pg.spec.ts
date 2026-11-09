// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The legacy `/items/:id/features` routes read the per-item `fs_`
// table directly. They used to ignore share geo limits and row scope,
// so a geo-limited or own-rows grantee listed every row there even
// though /geojson clipped the same table. This runs the real
// controller and service against Postgres with the real resolver.
// Own database, so it runs in parallel with the other pg suites.

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from '../items/sharing.service.js';
import { FeaturesService } from './features.service.js';
import { FeaturesController } from './features.controller.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the legacy scope suite would silently skip.',
  );
}

jest.setTimeout(120_000);

const DB = 'gg_legacy_scope';
const ITEM = '30000000-0000-4000-8000-000000000001';
const OWNER = '30000000-0000-4000-8000-000000000002';
const READER = '30000000-0000-4000-8000-000000000003';
const INSIDE = '30000000-0000-4000-8000-0000000000a1';
const OUTSIDE = '30000000-0000-4000-8000-0000000000a2';

const DISTRICT = {
  type: 'Polygon',
  coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
};

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('legacy v2 feature routes honour share scope', () => {
  let prismaClient: PrismaClient;
  let features: FeaturesService;
  let controller: FeaturesController;

  const owner = { id: OWNER, orgId: 'org', orgRole: 'viewer', groupIds: [] } as unknown as AuthUser;
  const reader = { id: READER, orgId: 'org', orgRole: 'viewer', groupIds: [] } as unknown as AuthUser;

  function share(extra: Record<string, unknown>) {
    return {
      itemId: ITEM,
      principalType: 'user',
      principalId: READER,
      permission: 'edit',
      rowScope: 'all',
      editRowScope: null,
      expiresAt: null,
      geoLimit: null,
      geoBoundaryId: null,
      ...extra,
    };
  }

  let shares: unknown[] = [];

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    const url = databaseUrl(TEST_URL!, DB);
    const setup = new Pool({ connectionString: url, max: 1 });
    await setup.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await setup.end();
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 2 }),
    });
    const prisma = prismaClient as unknown as PrismaService;
    features = new FeaturesService(prisma, {
      notifySourceWrite: async () => undefined,
    } as unknown as DerivedLayerCacheRefreshService);
    const item = () => ({
      id: ITEM,
      orgId: 'org',
      ownerId: OWNER,
      type: 'data_layer',
      access: 'private',
      data: { version: 2, storageType: 'postgis' },
      shares,
    });
    controller = new FeaturesController(
      features,
      { get: async () => item() } as never,
      new SharingService(prisma, new PolicyService()),
      { itemShare: { findMany: async () => shares } } as never,
    );
    await features.provisionTable(ITEM);
    await features.bulkInsert(
      ITEM,
      [
        { globalId: INSIDE, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { n: 1 } },
        { globalId: OUTSIDE, geometry: { type: 'Point', coordinates: [50, 50] }, properties: { n: 2 } },
      ],
      owner,
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
  });

  it('list, getOne and history are clipped to the share geo limit', async () => {
    shares = [share({ geoLimit: DISTRICT })];
    const fc = await controller.list(reader, ITEM);
    expect(fc.features.map((f) => f.id)).toEqual([INSIDE]);
    await expect(controller.getOne(reader, ITEM, OUTSIDE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await controller.history(reader, ITEM, OUTSIDE)).toEqual([]);
  });

  it('own-rows grantees list nothing they did not create', async () => {
    shares = [share({ rowScope: 'own' })];
    const fc = await controller.list(reader, ITEM);
    expect(fc.features).toEqual([]);
  });

  it('PATCH and DELETE outside the edit scope read as not found', async () => {
    shares = [share({ geoLimit: DISTRICT })];
    await expect(
      controller.update(reader, ITEM, OUTSIDE, { properties: { n: 9 } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.remove(reader, ITEM, OUTSIDE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const still = await features.getFeature(ITEM, OUTSIDE);
    expect(still.properties).toMatchObject({ n: 2 });
  });

  it('a limited editor cannot replace the whole layer', async () => {
    shares = [share({ geoLimit: DISTRICT })];
    await expect(
      controller.bulkImport(reader, ITEM, { type: 'FeatureCollection', features: [] }),
    ).rejects.toThrow(/limited/);
  });

  it('an unscoped editor still reads every row', async () => {
    shares = [share({})];
    const fc = await controller.list(reader, ITEM);
    expect(fc.features).toHaveLength(2);
  });
});
