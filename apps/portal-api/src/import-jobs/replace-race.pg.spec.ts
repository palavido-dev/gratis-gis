// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A replace import deletes the layer at the start of a long COPY
// transaction, but online edits are not blocked while it runs. An edit
// committed during the COPY must not survive the replace as a ghost:
// the commit has to tombstone it, after the edit, under the item lock.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type ImportJob } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { EngineService } from '../engine/engine.service.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import type { SharingService } from '../items/sharing.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';
import { ImportJobsWorker } from './import-jobs.worker.js';
import type { ImportJobsService } from './import-jobs.service.js';
import type { IngestService } from '../ingest/ingest.service.js';
import type { IngestStagingService } from '../ingest/ingest-staging.service.js';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the replace race suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '21000000-0000-4000-8000-000000000001';
const USER = '21000000-0000-4000-8000-000000000002';
const ITEM = '21000000-0000-4000-8000-000000000003';
const LAYER = 'layer-copy';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('replace import racing an online edit', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  let engine: DataLayerEngine;
  const dbName = 'gg_replace_race';
  const dbUrl = databaseUrl(TEST_URL!, dbName);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const scope = `data_layer:${ITEM}:${LAYER}`;
  const user = {
    id: USER,
    orgId: ORG,
    orgRole: 'admin',
    username: 'race-user',
  } as unknown as AuthUser;

  const point = (x: number) => ({ type: 'Point', coordinates: [x, 2] });

  function job(mode: 'append' | 'replace'): ImportJob {
    return {
      id: '31000000-0000-4000-8000-000000000010',
      itemId: ITEM,
      layerId: LAYER,
      stagingId: 'staging',
      sourceFileName: 'notes.geojson',
      sourceLayerName: 'notes',
      mode,
      createdBy: USER,
      orgId: ORG,
      status: 'running',
      totalFeatures: 1,
      processedFeatures: 0,
      insertedFeatures: 0,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      lastHeartbeatAt: new Date(),
    };
  }

  let cancelled = false;
  let batchesRead = 0;

  function worker(
    rows: Array<{ properties: Record<string, unknown> }>,
    duringCopy?: () => Promise<void>,
    repeat = 1,
  ) {
    const ingest = {
      streamLayerFromPath: async (
        _file: string,
        _layer: string | undefined,
        onBatch: (
          batch: Array<{ geometry: unknown; properties: Record<string, unknown> }>,
          progress: { processed: number; total: number },
        ) => Promise<void>,
      ) => {
        if (duringCopy) await duringCopy();
        for (let n = 0; n < repeat; n++) {
          batchesRead += 1;
          await onBatch(
            rows.map((row, i) => ({ geometry: point(i + 1), properties: row.properties })),
            { processed: rows.length, total: rows.length },
          );
        }
        return {
          fields: [],
          driver: 'GeoJSON',
          layerName: 'notes',
          sourceSrs: 'EPSG:4326',
          total: rows.length,
        };
      },
    };
    return new ImportJobsWorker(
      {
        isCancelled: async () => cancelled,
        updateProgress: async () => undefined,
        markSucceeded: async () => undefined,
        markFailed: async () => undefined,
        zeroInsertedForCancelled: async () => undefined,
        zeroInsertedForFailed: async () => undefined,
      } as unknown as ImportJobsService,
      ingest as unknown as IngestService,
      {
        getStaging: async () => ({ filePath: '/tmp/notes.geojson', sizeBytes: 12 }),
      } as unknown as IngestStagingService,
      service,
      {
        stampFeatureCounts: async () => undefined,
        aggregateBbox: async () => null,
      } as unknown as DataLayerTablesService,
      prismaClient as unknown as PrismaService,
    );
  }

  async function heads(): Promise<Map<string, string>> {
    const r = await pool.query<{ entity: string; kind: string }>(
      `SELECT DISTINCT ON (entity) entity::text AS entity, kind
       FROM observation WHERE scope = $1
       ORDER BY entity, valid_from DESC, tx_time DESC, id DESC`,
      [scope],
    );
    return new Map(r.rows.map((row) => [row.entity, row.kind]));
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    process.env.DATABASE_URL = dbUrl;
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
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'race-org', 'Race Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'race-user', 'race@example.test', 'Race User', 'admin')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Race layer', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        USER,
        JSON.stringify({ version: 3, layers: [{ id: LAYER, syncVersion: 0, fields: [] }] }),
      ],
    );
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('tombstones a feature edited online while the replace was copying', async () => {
    await worker([{ properties: { name: 'old' } }]).runJob(job('append'));
    const [edited] = [...(await heads()).keys()];
    expect(edited).toBeDefined();

    await worker([{ properties: { name: 'new' } }], async () => {
      // Commits on its own connection while the COPY transaction is open.
      await service.updateFeature(ITEM, LAYER, edited!, { properties: { name: 'edited' } }, user);
    }).runJob(job('replace'));

    const after = await heads();
    // The edited feature is gone; only the new file's feature is live.
    expect(after.get(edited!)).toBe('delete');
    expect([...after.values()].filter((k) => k !== 'delete')).toHaveLength(1);

    // A delta client sees the edit, then the delete, never the reverse.
    const delta = await engine.listDeltaSince({ itemId: ITEM, layerId: LAYER, since: 1 });
    const forEdited = delta
      .filter((row) => row.entity === edited)
      .sort((a, b) => a.syncVersion - b.syncVersion);
    expect(forEdited[forEdited.length - 1]!.kind).toBe('delete');
  });

  it('stops reading the source as soon as the import is cancelled', async () => {
    const before = await heads();
    cancelled = true;
    batchesRead = 0;
    try {
      await worker([{ properties: { name: 'never' } }], undefined, 50).runJob(job('replace'));
    } finally {
      cancelled = false;
    }
    // The reader stopped on the first batch instead of pumping all 50.
    expect(batchesRead).toBe(1);
    // And nothing changed: the replace rolled back.
    expect(await heads()).toEqual(before);
  });
});
