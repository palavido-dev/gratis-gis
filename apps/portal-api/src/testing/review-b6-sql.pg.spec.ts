// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Raw SQL added in the 2026-11 review fixes, run against Postgres:
 *   - the pyramid worker's stale-tiling recovery, with one row whose
 *     owner-written timestamp does not parse (finding 20-6);
 *   - the records bbox test on bbox_geom (18-7);
 *   - the landing template read (18-5);
 *   - the private asset owner lookup (19-9).
 *
 * Runs in its own throwaway schema with a minimal copy of the item
 * columns these statements touch, plus the safe-cast functions from
 * their migration. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import { TileLayerPyramidWorker } from '../tile-layer/pyramid.worker.js';
import { queryPublicRecords } from '../public/ogc/records-core.js';
import { findItemIdOwningKey } from '../storage/storage.controller.js';
import { ItemsService } from '../items/items.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the review SQL '
    + 'pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

d('review fixes SQL against Postgres', () => {
  const schema = `gg_b6_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;

  async function insert(row: {
    type?: string;
    data?: unknown;
    access?: string;
    bbox?: number[];
    storageRef?: string | null;
    deleted?: boolean;
    orgId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO ${schema}.item
         (id, type, data_json, access, bbox, storage_ref, deleted_at, org_id, created_at, updated_at)
       VALUES ($1, $2::${schema}."ItemType", $3, $4, $5, $6, $7, $8, now(), now())`,
      [
        id,
        row.type ?? 'map',
        JSON.stringify(row.data ?? {}),
        row.access ?? 'public',
        row.bbox ?? [],
        row.storageRef ?? null,
        row.deleted ? new Date() : null,
        row.orgId ?? null,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path = ${schema}, public`);
    await admin.query(
      `CREATE TYPE ${schema}."ItemType" AS ENUM ('map', 'tile-layer', 'web-app', 'data-layer',
        'arcgis-service', 'wms-service', 'wfs-service', 'geo-boundary')`,
    );
    await admin.query(`
      CREATE TABLE ${schema}.item (
        id uuid PRIMARY KEY,
        type ${schema}."ItemType" NOT NULL,
        data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        access text NOT NULL,
        bbox double precision[] NOT NULL DEFAULT '{}',
        bbox_geom geometry(Polygon, 4326) GENERATED ALWAYS AS (
          CASE WHEN array_length(bbox, 1) = 4
            THEN ST_MakeEnvelope(bbox[1], bbox[2], bbox[3], bbox[4], 4326)
            ELSE NULL END
        ) STORED,
        storage_ref text,
        org_id uuid,
        deleted_at timestamp(3),
        created_at timestamp(3) NOT NULL,
        updated_at timestamp(3) NOT NULL
      )
    `);
    await admin.query(`CREATE TABLE ${schema}.item_share (item_id uuid NOT NULL)`);
    const casts = readFileSync(
      join(__dirname, '../../prisma/migrations/20261112190500_safe_text_casts/migration.sql'),
      'utf8',
    );
    await admin.query(casts);
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('recovers a stale tiling row even when another row holds garbage', async () => {
    const old = new Date(Date.now() - 24 * 3600_000).toISOString();
    const victim = await insert({
      type: 'tile-layer',
      data: { processingState: 'tiling', tilingStartedAt: old },
    });
    await insert({
      type: 'tile-layer',
      data: { processingState: 'tiling', tilingStartedAt: 'x', tilingAttempts: 'many' },
    });
    const worker = new TileLayerPyramidWorker(client as never, {} as never);
    await (worker as unknown as {
      reclaimStaleTilings(r: string): Promise<void>;
    }).reclaimStaleTilings('loop');
    const r = await admin.query(`SELECT data_json FROM ${schema}.item WHERE id = $1`, [victim]);
    expect(r.rows[0].data_json.processingState).toBe('cog-ready');
  });

  it('tests a records bbox in SQL against bbox_geom', async () => {
    const inside = await insert({ bbox: [-80.2, 39.1, -80.0, 39.3] });
    await insert({ bbox: [-70, 30, -69, 31] });
    await insert({ bbox: [-80.2, 39.1, -80.0, 39.3], access: 'private' });
    const raw: string[] = [];
    const out = await queryPublicRecords(
      {
        $queryRaw: client.$queryRaw.bind(client) as never,
        item: {
          count: async (args: { where: unknown }) => {
            raw.push(JSON.stringify(args.where));
            return 1;
          },
          findMany: async () => [],
        },
      } as never,
      {
        where: { access: 'public', deletedAt: null },
        orderBy: undefined,
        offset: 0,
        limit: 10,
        bbox: '-80.5,39.0,-80.0,39.5',
      },
    );
    expect(out.total).toBe(1);
    expect(raw[0]).toContain(inside);
  });

  it('reads only the template of web_app rows for the landing', async () => {
    const app = await insert({ type: 'web-app', data: { template: 'viewer', secret: 1 } });
    const rows = await client.$queryRaw<Array<{ id: string; template: string | null }>>`
      SELECT id, data_json->>'template' AS template
      FROM "item"
      WHERE id = ANY(${[app]}::uuid[])`;
    expect(rows).toEqual([{ id: app, template: 'viewer' }]);
  });

  it('finds the oldest live item that owns a storage key', async () => {
    const key = `item-tile-layer/${randomUUID()}`;
    await insert({ data: { cogStorageKey: key }, deleted: true });
    const owner = await insert({ data: { pmtilesStorageKey: key } });
    await expect(findItemIdOwningKey(client as never, key)).resolves.toBe(owner);
    const byRef = `item-file/${randomUUID()}`;
    const refOwner = await insert({ storageRef: byRef });
    await expect(findItemIdOwningKey(client as never, byRef)).resolves.toBe(refOwner);
    await expect(findItemIdOwningKey(client as never, 'item-file/none')).resolves.toBeNull();
  });

  it('collects spatial list ids only from the caller org, public items and shared items', async () => {
    const org = randomUUID();
    const box = [-1, -1, 1, 1];
    const mine = await insert({ bbox: box, access: 'private', orgId: org });
    const pub = await insert({ bbox: box, access: 'public', orgId: randomUUID() });
    const shared = await insert({ bbox: box, access: 'private', orgId: randomUUID() });
    await admin.query(`INSERT INTO ${schema}.item_share (item_id) VALUES ($1)`, [shared]);
    const foreign = await insert({ bbox: box, access: 'private', orgId: randomUUID() });
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, { prisma: client, sharing: { visibleWhere: () => ({}) } });
    const where = (await (svc as unknown as {
      buildListWhere(u: unknown, o: unknown): Promise<{ AND: Array<{ id?: { in: string[] } }> }>;
    }).buildListWhere({ id: 'u', orgId: org }, { bbox: [-2, -2, 2, 2] })) as {
      AND: Array<{ id?: { in: string[] } }>;
    };
    const ids = where.AND.find((c) => c.id)!.id!.in;
    expect(ids).toEqual(expect.arrayContaining([mine, pub, shared]));
    expect(ids).not.toContain(foreign);
  });
});
