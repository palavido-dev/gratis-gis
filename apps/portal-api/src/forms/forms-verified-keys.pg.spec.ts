// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Finding 10-2: submit records the attachment keys the submitter was
 * issued in form_submission.verified_attachment_keys, and the repair
 * pass trusts only those. This runs the migration's DDL and the real
 * Prisma column mapping against Postgres: the keys survive a write
 * and a read, and older rows read back as an empty list.
 *
 * Tables are a minimal copy in a throwaway schema, like the other pg
 * specs. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the verified keys '
    + 'pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

const MIGRATION = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20261113120000_form_submission_verified_keys',
  'migration.sql',
);

d('form_submission.verified_attachment_keys', () => {
  const schema = `gg_forms_vkeys_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;
  const formId = randomUUID();
  const orgId = randomUUID();
  const older = randomUUID();

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path = ${schema}`);
    await admin.query(`
      CREATE TABLE form_submission (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id uuid NOT NULL,
        org_id uuid NOT NULL,
        client_id text NOT NULL,
        schema_version int NOT NULL,
        response jsonb NOT NULL,
        submitted_by uuid,
        captured_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // A row stored before the column existed.
    await admin.query(
      `INSERT INTO form_submission (id, form_id, org_id, client_id, schema_version, response, captured_at)
       VALUES ($1, $2, $3, 'old', 1, '{}', now())`,
      [older, formId, orgId],
    );
    await admin.query(readFileSync(MIGRATION, 'utf8'));
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }, { schema }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('stores the verified keys and reads them back', async () => {
    const row = await client.formSubmission.create({
      data: {
        formId,
        orgId,
        clientId: 'c1',
        schemaVersion: 1,
        response: {},
        capturedAt: new Date(),
        verifiedAttachmentKeys: ['feature-attachment/a', 'feature-attachment/b'],
      },
      select: { id: true },
    });
    const back = await client.formSubmission.findUnique({ where: { id: row.id } });
    expect(back?.verifiedAttachmentKeys).toEqual(['feature-attachment/a', 'feature-attachment/b']);
  });

  it('reads an older row as having no verified keys', async () => {
    const back = await client.formSubmission.findUnique({ where: { id: older } });
    expect(back?.verifiedAttachmentKeys).toEqual([]);
  });

  it('applies the migration twice without error', async () => {
    await expect(admin.query(readFileSync(MIGRATION, 'utf8'))).resolves.toBeDefined();
  });
});
