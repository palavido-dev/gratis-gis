// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tenant context needs the org of each claimed job. Three claim
// queries were changed to return it (script runs, tile pyramids,
// notifications, plus the script schedule read). This runs those real
// queries against migrated Postgres and checks each job body runs as
// its own org.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { ApiKeyService } from '../auth/api-key.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { NotificationsWorker } from '../notifications/notifications.worker.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ScriptRunnerWorker } from '../scripts/script-runner.worker.js';
import { ScriptScheduleService } from '../scripts/script-schedule.service.js';
import type { ScriptsService } from '../scripts/scripts.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { TileLayerPyramidWorker } from '../tile-layer/pyramid.worker.js';
import { currentTenant, type TenantContext } from './tenant-context.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the tenant claims suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_tenant_claims';
const ORG_A = '30000000-0000-4000-8000-00000000000a';
const ORG_B = '30000000-0000-4000-8000-00000000000b';
const USER_A = '30000000-0000-4000-8000-0000000000a1';
const USER_B = '30000000-0000-4000-8000-0000000000b1';
const SCRIPT_B = '30000000-0000-4000-8000-0000000000b2';
const TILES_A = '30000000-0000-4000-8000-0000000000a3';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('claim queries carry the org of each job', () => {
  // Built lazily: describe.skip still runs this body without a URL.
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let client: PrismaClient;
  const prisma = () => client as unknown as PrismaService;
  const leader = { shouldRun: () => true } as unknown as LeaderElectionService;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 2 });
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 2 }),
    });
    for (const [org, slug] of [
      [ORG_A, 'claims-a'],
      [ORG_B, 'claims-b'],
    ] as const) {
      await pool.query(`INSERT INTO organization (id, slug, name) VALUES ($1, $2, $2)`, [
        org,
        slug,
      ]);
    }
    for (const [user, org, name] of [
      [USER_A, ORG_A, 'claims-user-a'],
      [USER_B, ORG_B, 'claims-user-b'],
    ] as const) {
      await pool.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
         VALUES ($1, $2, $3, $3 || '@example.test', $3, 'admin')`,
        [user, org, name],
      );
    }
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  });

  it('a claimed script run carries its org', async () => {
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'script', 'Script', $4::jsonb, now())`,
      [
        SCRIPT_B,
        ORG_B,
        USER_B,
        JSON.stringify({
          schedule: { mode: 'daily', hour: 3, minute: 0 },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO script_run (id, script_id, org_id, user_id, state, source_snapshot)
       VALUES (gen_random_uuid(), $1, $2, $3, 'queued', 'print(1)')`,
      [SCRIPT_B, ORG_B, USER_B],
    );
    const worker = new ScriptRunnerWorker(prisma(), {} as ApiKeyService);
    const claimed = await (
      worker as unknown as {
        claimOne(): Promise<{ orgId: string; userId: string } | null>;
      }
    ).claimOne();
    expect(claimed).toMatchObject({ orgId: ORG_B, userId: USER_B });
  });

  it('the script schedule read passes each script org to its job', async () => {
    const svc = new ScriptScheduleService(prisma(), {} as ScriptsService, leader);
    const register = jest
      .spyOn(
        svc as unknown as {
          register(id: string, e: string, t: string, o?: string): void;
        },
        'register',
      )
      .mockImplementation(() => undefined);
    await (svc as unknown as { reconcile(): Promise<void> }).reconcile();
    const call = register.mock.calls.find(([id]) => id === SCRIPT_B);
    expect(call?.[3]).toBe(ORG_B);
  });

  it('a claimed tile pyramid carries the item org', async () => {
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'tile-layer', 'Tiles', $4::jsonb, now())`,
      [
        TILES_A,
        ORG_A,
        USER_A,
        JSON.stringify({
          version: 1,
          format: 'cog',
          storageKey: 'k',
          processingState: 'cog-ready',
        }),
      ],
    );
    const worker = new TileLayerPyramidWorker(prisma(), {} as StorageService);
    const claim = await (
      worker as unknown as {
        claimNext(): Promise<{ itemId: string; orgId: string } | null>;
      }
    ).claimNext();
    expect(claim).toMatchObject({ itemId: TILES_A, orgId: ORG_A });
  });

  it('each notification is processed as its recipient org', async () => {
    for (const user of [USER_A, USER_B]) {
      await pool.query(
        `INSERT INTO notification (user_id, type, payload, channel, address, status, scheduled_at)
         VALUES ($1, 'share-created', '{}'::jsonb, 'email', 'x@example.test', 'queued', now() - interval '1 minute')`,
        [user],
      );
    }
    const cfg = { get: () => undefined };
    const worker = new NotificationsWorker(
      prisma(),
      {} as never,
      cfg as never,
      {} as never,
      leader,
    );
    const seen: Array<TenantContext | undefined> = [];
    jest
      .spyOn(worker as unknown as { processOne(id: string): Promise<void> }, 'processOne')
      .mockImplementation(async () => {
        seen.push(currentTenant());
      });
    await (worker as unknown as { drainBatch(): Promise<void> }).drainBatch();
    expect(seen).toHaveLength(2);
    expect(seen.map((c) => (c?.kind === 'org' ? c.orgId : c?.kind)).sort()).toEqual(
      [ORG_A, ORG_B].sort(),
    );
  });
});
