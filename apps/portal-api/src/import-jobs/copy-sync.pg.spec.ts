// SPDX-License-Identifier: AGPL-3.0-or-later
//
// COPY imports stamp syncVersion on the writer's connection, after
// the stream is sealed and before commit. The worker is the caller.
// Abort and cancel do not move the cursor. A replace writes
// tombstones for entities the new file dropped, and delta returns
// those deletes.

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
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the COPY sync suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '20000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-000000000002';
const ITEM = '20000000-0000-4000-8000-000000000003';
const LAYER = 'layer-copy';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('COPY syncVersion through the import worker', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let service: DataLayerFeaturesService;
  let engine: DataLayerEngine;
  let cancelled = false;
  let explode = false;
  const dbUrl = databaseUrl(TEST_URL!, 'gg_copy_sync');
  const previousDatabaseUrl = process.env.DATABASE_URL;

  const point = (x: number) => ({ type: 'Point', coordinates: [x, 2] });

  function job(mode: 'append' | 'replace'): ImportJob {
    return {
      id: '30000000-0000-4000-8000-000000000010',
      itemId: ITEM,
      layerId: LAYER,
      stagingId: 'staging',
      sourceFileName: 'notes.geojson',
      sourceLayerName: 'notes',
      mode,
      createdBy: USER,
      orgId: ORG,
      status: 'running',
      totalFeatures: 2,
      processedFeatures: 0,
      insertedFeatures: 0,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      lastHeartbeatAt: new Date(),
    };
  }

  function worker(
    rows: Array<{ properties: Record<string, unknown>; globalId?: string }>,
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
        if (explode) throw new Error('forced stream failure');
        await onBatch(
          rows.map((row, i) => ({
            geometry: point(i + 1),
            properties: row.properties,
            ...(row.globalId !== undefined ? { globalId: row.globalId } : {}),
          })),
          { processed: rows.length, total: rows.length },
        );
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

  async function cursor(): Promise<number> {
    const row = await pool.query<{ data_json: { layers: Array<{ syncVersion?: number }> } }>(
      'SELECT data_json FROM item WHERE id = $1',
      [ITEM],
    );
    return row.rows[0]!.data_json.layers[0]!.syncVersion ?? 0;
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query('DROP DATABASE IF EXISTS gg_copy_sync');
    await admin.query('CREATE DATABASE gg_copy_sync');
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }),
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
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'copy-org', 'Copy Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'copy-user', 'copy@example.test', 'Copy User', 'viewer')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Copy layer', $4::jsonb, now())`,
      [
        ITEM,
        ORG,
        USER,
        JSON.stringify({
          version: 3,
          layers: [{ id: LAYER, syncVersion: 0, fields: [] }],
        }),
      ],
    );
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('stamps an append, then a replace with tombstones, and ignores abort', async () => {
    await worker([
      { properties: { name: 'one' } },
      { properties: { name: 'two' } },
    ]).runJob(job('append'));
    expect(await cursor()).toBe(1);
    const first = await engine.listDeltaSince({
      itemId: ITEM,
      layerId: LAYER,
      since: 0,
    });
    expect(first.map((row) => row.kind).sort()).toEqual(['create', 'create']);
    expect(first.every((row) => row.syncVersion === 1)).toBe(true);
    const kept = first.map((row) => row.entity);

    await worker(
      kept.map((entity) => ({ properties: { name: 'again' }, globalId: entity })),
    ).runJob(job('append'));
    expect(await cursor()).toBe(1);
    const afterDup = await engine.listDeltaSince({
      itemId: ITEM,
      layerId: LAYER,
      since: 1,
    });
    expect(afterDup).toEqual([]);

    await worker([{ properties: { name: 'three' } }]).runJob(job('replace'));
    expect(await cursor()).toBe(2);
    const second = await engine.listDeltaSince({
      itemId: ITEM,
      layerId: LAYER,
      since: 1,
    });
    const deletes = second.filter((row) => row.kind === 'delete').map((row) => row.entity);
    const creates = second.filter((row) => row.kind === 'create');
    expect(deletes.sort()).toEqual([...kept].sort());
    expect(creates).toHaveLength(1);
    expect(creates[0]!.syncVersion).toBe(2);
    expect(second.every((row) => row.syncVersion === 2)).toBe(true);

    const before = await cursor();
    const liveBefore = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT DISTINCT ON (entity) kind
         FROM observation
         WHERE scope = $1
         ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
       ) latest WHERE kind <> 'delete'`,
      [`data_layer:${ITEM}:${LAYER}`],
    );
    explode = true;
    await worker([{ properties: { name: 'nope' } }]).runJob(job('replace'));
    explode = false;
    expect(await cursor()).toBe(before);
    const liveAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT DISTINCT ON (entity) kind
         FROM observation
         WHERE scope = $1
         ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
       ) latest WHERE kind <> 'delete'`,
      [`data_layer:${ITEM}:${LAYER}`],
    );
    expect(liveAfter.rows[0]!.n).toBe(liveBefore.rows[0]!.n);

    cancelled = true;
    await worker([{ properties: { name: 'nope' } }]).runJob(job('replace'));
    cancelled = false;
    expect(await cursor()).toBe(before);
  });
});
