// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The form-mirror repair query and the paired-layer insert run
// against the migrated project database. Set TEST_DATABASE_URL to
// that database. The rows use fixed ids and are removed afterwards.
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

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
import type { DataLayerAttachmentsService } from '../data-layer/attachments.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { FormsService } from './forms.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

jest.setTimeout(120_000);

const ORG = '22222222-2222-4222-8222-222222222221';
const USER = '22222222-2222-4222-8222-222222222222';
const LAYER_ITEM = '22222222-2222-4222-8222-222222222223';
const FORM = '22222222-2222-4222-8222-222222222224';
const LAYER_KEY = 'submissions';

d('form mirror reconciliation on migrated Postgres', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let forms: FormsService;

  const user = {
    id: USER,
    orgId: ORG,
    username: 'mirror-user',
    email: 'mirror@example.test',
    orgSlug: 'mirror-org',
    orgRole: 'admin',
    groupIds: [],
    capabilities: new Set<string>(),
  } as AuthUser;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_URL, max: 4 }),
    });
    const prisma = prismaClient as unknown as PrismaService;
    const engine = new DataLayerEngine(
      new EngineService(prisma),
      prisma,
      { checkFeature: () => true } as unknown as LensPolicyService,
      new TileCacheService(),
    );
    const features = new DataLayerFeaturesService(
      prisma,
      { notifySourceWrite: async () => undefined } as unknown as DerivedLayerCacheRefreshService,
      engine,
      { noteFeatureWrite: () => undefined } as unknown as ItemBboxRefreshService,
      { visibleWhere: () => ({}) } as unknown as SharingService,
      { principalForUserId: async () => null } as unknown as AuthSyncService,
    );
    forms = new FormsService(
      prisma,
      { notify: async () => undefined } as unknown as NotificationsService,
      features,
      { register: async () => undefined } as unknown as DataLayerAttachmentsService,
      { shouldRun: () => true } as unknown as LeaderElectionService,
    );
    await pool.query('DELETE FROM form_submission WHERE form_id = $1', [FORM]);
    await pool.query('DELETE FROM item WHERE id IN ($1, $2)', [FORM, LAYER_ITEM]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organization WHERE id = $1', [ORG]);
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'mirror-org', 'Mirror Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'mirror-user', 'mirror@example.test', 'Mirror User', 'admin')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Paired', $4::jsonb, now())`,
      [
        LAYER_ITEM,
        ORG,
        USER,
        JSON.stringify({
          version: 3,
          layers: [{ id: LAYER_KEY, syncVersion: 0, fields: [] }],
        }),
      ],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'form', 'Crew form', $4::jsonb, now())`,
      [
        FORM,
        ORG,
        USER,
        JSON.stringify({
          linkedLayerId: LAYER_ITEM,
          linkedLayerKey: LAYER_KEY,
        }),
      ],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM observation WHERE scope = $1', [
      `data_layer:${LAYER_ITEM}:${LAYER_KEY}`,
    ]);
    await pool.query('DELETE FROM form_submission WHERE form_id = $1', [FORM]);
    await pool.query('DELETE FROM item WHERE id IN ($1, $2)', [FORM, LAYER_ITEM]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organization WHERE id = $1', [ORG]);
    await prismaClient.$disconnect();
    await pool.end();
  });

  it('writes one observation for a submission the mirror missed, and a second pass does not duplicate it', async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO form_submission
         (form_id, org_id, client_id, schema_version, response, submitted_by, captured_at)
       VALUES ($1, $2, 'client-1', 1, '{"note":"crew"}'::jsonb, $3, now())
       RETURNING id`,
      [FORM, ORG, USER],
    );
    const submissionId = inserted.rows[0]!.id;
    const missing = await pool.query(
      `SELECT s.id FROM form_submission s
       JOIN item f ON f.id = s.form_id
       WHERE s.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM observation o
           WHERE o.entity = s.id
             AND o.scope = 'data_layer:' || (f.data_json->>'linkedLayerId')
               || ':' || COALESCE(f.data_json->>'linkedLayerKey', 'submissions')
             AND o.kind <> 'delete'
         )`,
      [submissionId],
    );
    expect(missing.rows).toHaveLength(1);

    const repaired = await forms.reconcileFormMirrors();
    expect(repaired).toBeGreaterThanOrEqual(1);
    const obs = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM observation
       WHERE entity = $1 AND scope = $2 AND kind <> 'delete'`,
      [submissionId, `data_layer:${LAYER_ITEM}:${LAYER_KEY}`],
    );
    expect(Number(obs.rows[0]!.n)).toBe(1);

    const again = await forms.reconcileFormMirrors();
    expect(again).toBe(0);
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM observation WHERE entity = $1`,
      [submissionId],
    );
    expect(Number(after.rows[0]!.n)).toBe(1);
  });
});
