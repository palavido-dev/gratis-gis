// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Share limits on the v3 write paths. An edit share can narrow the
// grantee to an area (geo limit) or to their own rows, and the layer
// can be own-rows-only. These tests resolve the caller's scope with
// the real SharingService.featureScopeFor and run the real feature
// service and engine against Postgres, so they cover the two halves
// that used to disagree: the resolver (which let the org tier widen
// a write) and PATCH, DELETE and Calculate Field (which never applied
// the geo limit to the rows they touch). Own database, so it runs in
// parallel with the other pg suites.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Item, ItemShare } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from './features.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import {
  SharingService,
  featureScopeFilter,
} from '../items/sharing.service.js';
import type { PolicyService } from '../policy/policy.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the share-scope suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_share_scope_writes';
const ORG = '20000000-0000-4000-8000-000000000001';
const OWNER = '20000000-0000-4000-8000-000000000002';
const EDITOR = '20000000-0000-4000-8000-000000000003';
const ITEM = '20000000-0000-4000-8000-000000000004';
const LAYER = 'sites';
const OWN_LAYER = 'own';
const INSIDE = '20000000-0000-4000-8000-0000000000a1';
const OUTSIDE = '20000000-0000-4000-8000-0000000000a2';
const OUTSIDE_DEL = '20000000-0000-4000-8000-0000000000a3';
const MINE = '20000000-0000-4000-8000-0000000000b1';
const THEIRS = '20000000-0000-4000-8000-0000000000b2';

/** District 3: the unit square around the origin. */
const DISTRICT = {
  type: 'Polygon',
  coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
};

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('share limits on v3 writes', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  let sharing: SharingService;
  let engine: DataLayerEngine;
  const url = databaseUrl(TEST_URL!, DB);

  const owner = { id: OWNER, orgId: ORG, orgRole: 'viewer', groupIds: [] } as unknown as AuthUser;
  const editor = { id: EDITOR, orgId: ORG, orgRole: 'viewer', groupIds: [] } as unknown as AuthUser;

  // An org-access layer: every org member reads it through the org
  // tier, and the editor also holds an edit share clipped to the
  // district. The org tier grants read only, so it must not widen
  // the editor's writes.
  const item = {
    id: ITEM,
    orgId: ORG,
    ownerId: OWNER,
    access: 'org',
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
  } as unknown as Item;
  const geoShare = {
    itemId: ITEM,
    principalType: 'user',
    principalId: EDITOR,
    permission: 'edit',
    geoLimit: DISTRICT,
    geoBoundaryId: null,
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
  } as unknown as ItemShare;
  const plainShare = {
    ...geoShare,
    geoLimit: null,
  } as unknown as ItemShare;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 4 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 4 }),
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
    sharing = new SharingService(prisma, {} as unknown as PolicyService);

    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'scope-org', 'Scope Org')`,
      [ORG],
    );
    for (const [id, name] of [[OWNER, 'owner'], [EDITOR, 'editor']] as const) {
      await pool.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
         VALUES ($1, $2, $3, $4, $3, 'viewer')`,
        [id, ORG, name, `${name}@example.test`],
      );
    }
    const fields = [
      { name: 'status', type: 'string', label: 'Status', nullable: true },
    ];
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Sites', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        OWNER,
        JSON.stringify({
          version: 3,
          layers: [
            { id: LAYER, syncVersion: 0, geometryType: 'Point', fields },
            {
              id: OWN_LAYER,
              syncVersion: 0,
              geometryType: 'Point',
              editingPolicy: 'own-rows-only',
              fields,
            },
          ],
        }),
      ],
    );
    await service.insertFeatures(
      ITEM,
      LAYER,
      [
        { globalId: INSIDE, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { status: 'open' } },
        { globalId: OUTSIDE, geometry: { type: 'Point', coordinates: [50, 50] }, properties: { status: 'open' } },
        { globalId: OUTSIDE_DEL, geometry: { type: 'Point', coordinates: [60, 60] }, properties: { status: 'open' } },
      ],
      owner,
    );
    await service.insertFeatures(
      ITEM,
      OWN_LAYER,
      [{ globalId: THEIRS, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { status: 'open' } }],
      owner,
    );
    await service.insertFeatures(
      ITEM,
      OWN_LAYER,
      [{ globalId: MINE, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { status: 'open' } }],
      editor,
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  async function editScope(layerPolicy: 'all-rows' | 'own-rows-only', share: ItemShare) {
    return sharing.featureScopeFor(editor, item, [share], {
      action: 'edit',
      layerPolicy,
    });
  }

  async function status(layerId: string, id: string): Promise<unknown> {
    const r = await engine.listFeatures({ itemId: ITEM, layerId, entity: id });
    return r.features[0]?.properties.status;
  }

  it('the org tier does not lift the edit share geo limit', async () => {
    const scope = await editScope('all-rows', geoShare);
    expect(scope.geoLimit).toEqual(DISTRICT);
    // Reads still go through the org tier, which is unrestricted.
    const read = await sharing.featureScopeFor(editor, item, [geoShare], {
      action: 'read',
    });
    expect(read.geoLimit).toBeNull();
  });

  it('PATCH outside the geo limit reads as not found', async () => {
    const scope = await editScope('all-rows', geoShare);
    await expect(
      service.updateFeature(ITEM, LAYER, OUTSIDE, { properties: { status: 'closed' } }, editor, {
        shareScope: featureScopeFilter(scope),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await status(LAYER, OUTSIDE)).toBe('open');
  });

  it('DELETE outside the geo limit reads as not found', async () => {
    const scope = await editScope('all-rows', geoShare);
    await expect(
      service.deleteFeature(ITEM, LAYER, OUTSIDE_DEL, editor, {
        shareScope: featureScopeFilter(scope),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await status(LAYER, OUTSIDE_DEL)).toBe('open');
  });

  it('Calculate Field neither previews nor writes rows outside the geo limit', async () => {
    const scope = await editScope('all-rows', geoShare);
    const args = {
      itemId: ITEM,
      layerId: LAYER,
      expression: "'closed'",
      outputName: 'status',
      outputType: 'string' as const,
      scope: 'all' as const,
      user: editor,
      shareScope: featureScopeFilter(scope),
    };
    const dry = await service.calculateField({ ...args, dryRun: true });
    expect(dry.totalRows).toBe(1);
    expect(dry.sample.map((s) => s.id)).toEqual([INSIDE]);
    const sel = await service.calculateField({
      ...args,
      scope: 'selection',
      selectedIds: [OUTSIDE],
      dryRun: false,
    });
    expect(sel.appliedRows).toBe(0);
    const applied = await service.calculateField({ ...args, dryRun: false });
    expect(applied.appliedRows).toBe(1);
    expect(await status(LAYER, INSIDE)).toBe('closed');
    expect(await status(LAYER, OUTSIDE)).toBe('open');
  });

  it('an own-rows-only layer on an org item limits edits to the caller rows', async () => {
    const scope = await editScope('own-rows-only', plainShare);
    expect(scope.rowScope).toBe('own');
    await expect(
      service.updateFeature(ITEM, OWN_LAYER, THEIRS, { properties: { status: 'x' } }, editor, {
        shareScope: featureScopeFilter(scope),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await service.updateFeature(ITEM, OWN_LAYER, MINE, { properties: { status: 'mine' } }, editor, {
      shareScope: featureScopeFilter(scope),
    });
    expect(await status(OWN_LAYER, MINE)).toBe('mine');
    expect(await status(OWN_LAYER, THEIRS)).toBe('open');
  });
});
