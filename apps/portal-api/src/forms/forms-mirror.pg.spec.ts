// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The form mirror repair runs a raw query against item, form_submission,
 * and observation. A unit test with a mocked $queryRaw cannot catch a
 * wrong column name, and one shipped: it read `f.data` while the column
 * is `data_json`, so every repair tick failed. This runs the real query
 * through the real Prisma driver adapter against Postgres.
 *
 * The tables are a minimal copy of the columns the query reads, created
 * in a throwaway schema, the same way the other pg specs mirror the DDL
 * they need. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import { FormsService } from './forms.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the form mirror '
    + 'pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

d('form mirror repair query against Postgres', () => {
  const schema = `gg_forms_mirror_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;

  const layer = randomUUID();
  const trashedLayer = randomUUID();
  const form = randomUUID();
  const trashedForm = randomUUID();
  const formOnTrashedLayer = randomUUID();
  const unmirrored = randomUUID();
  const mirrored = randomUUID();
  const onTrashedForm = randomUUID();
  const onTrashedLayer = randomUUID();
  const old = randomUUID();
  const otherOrgLayer = randomUUID();
  const formOnOtherOrgLayer = randomUUID();
  const onOtherOrgLayer = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`
      CREATE TABLE ${schema}.item (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        deleted_at timestamptz
      );
      CREATE TABLE ${schema}.form_submission (
        id uuid PRIMARY KEY,
        form_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.observation (
        scope text NOT NULL,
        entity uuid NOT NULL,
        kind text NOT NULL
      );
    `);
    const linked = (id: string) => JSON.stringify({ linkedLayerId: id });
    await admin.query(
      `INSERT INTO ${schema}.item (id, org_id, data_json, deleted_at) VALUES
         ($1, $10, '{}', NULL),
         ($2, $10, '{}', now()),
         ($3, $10, $6::jsonb, NULL),
         ($4, $10, $6::jsonb, now()),
         ($5, $10, $7::jsonb, NULL),
         ($8, $11, '{}', NULL),
         ($9, $10, $12::jsonb, NULL)`,
      [
        layer, trashedLayer, form, trashedForm, formOnTrashedLayer,
        linked(layer), linked(trashedLayer),
        otherOrgLayer, formOnOtherOrgLayer, orgA, orgB, linked(otherOrgLayer),
      ],
    );
    await admin.query(
      `INSERT INTO ${schema}.form_submission (id, form_id, created_at) VALUES
         ($1, $6, now()),
         ($2, $6, now()),
         ($3, $7, now()),
         ($4, $8, now()),
         ($5, $6, now() - interval '30 days'),
         ($9, $10, now())`,
      [
        unmirrored, mirrored, onTrashedForm, onTrashedLayer, old, form, trashedForm,
        formOnTrashedLayer, onOtherOrgLayer, formOnOtherOrgLayer,
      ],
    );
    await admin.query(
      `INSERT INTO ${schema}.observation (scope, entity, kind) VALUES ($1, $2, 'create')`,
      [`data_layer:${layer}:submissions`, mirrored],
    );
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('repairs only the recent, unmirrored submission on a live form and same-org layer', async () => {
    const prisma = {
      $queryRaw: client.$queryRaw.bind(client),
      formSubmission: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          formId: form,
          orgId: randomUUID(),
          clientId: where.id,
          schemaVersion: 1,
          response: {},
          submittedBy: null,
          capturedAt: new Date(),
        })),
      },
      item: { findUnique: jest.fn(async () => ({ id: form, data: {} })) },
    };
    const leader = { shouldRun: () => true } as unknown as LeaderElectionService;
    const svc = new FormsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      leader,
    );
    const mirror = jest
      .spyOn(
        svc as unknown as { mirrorToPairedLayer: (a: unknown) => Promise<void> },
        'mirrorToPairedLayer',
      )
      .mockResolvedValue(undefined);

    await expect(svc.reconcileFormMirrors()).resolves.toBe(1);
    const tried = mirror.mock.calls.map(
      (c) => ((c as unknown[])[0] as { submissionId: string }).submissionId,
    );
    expect(tried).toEqual([unmirrored]);
  });
});
