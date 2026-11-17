// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ownership checks in key-ownership.ts run raw SQL over item and
 * feature_attachment, and read storage_upload_grant through Prisma.
 * A mocked client cannot catch a wrong column or a JSON path that
 * never matches, so this runs them against Postgres in a throwaway
 * schema. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import type { PrismaService } from '../prisma/prisma.service.js';
import {
  assertKeysAttachable,
  isKeyReferencedElsewhere,
  recordUploadGrant,
} from './key-ownership.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the storage key '
    + 'ownership pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

d('storage key ownership against Postgres', () => {
  const schema = `gg_key_owner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;
  let prisma: PrismaService;

  const victim = randomUUID();
  const attacker = randomUUID();
  const fileItem = randomUUID();
  const tileItem = randomUUID();
  const mosaicItem = randomUUID();
  const refItem = randomUUID();
  const pickerItem = randomUUID();
  const attachment = randomUUID();

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(`
      CREATE TABLE item (
        id uuid PRIMARY KEY,
        storage_ref text,
        data_json jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE feature_attachment (
        id uuid PRIMARY KEY,
        storage_key text NOT NULL
      );
    `);
    await admin.query(
      readFileSync(
        join(__dirname, '..', '..', 'prisma', 'migrations', '20261109110000_storage_upload_grant', 'migration.sql'),
        'utf8',
      ),
    );
    await admin.query(
      `INSERT INTO item (id, storage_ref, data_json) VALUES
        ($1, NULL, '{"storageKey":"item-file/a"}'),
        ($2, NULL, '{"storageKey":"item-tile-layer/src","cogStorageKey":"item-tile-layer/cog","pmtilesStorageKey":"item-tile-layer/pm"}'),
        ($3, NULL, '{"sources":[{"storageKey":"item-tile-layer/s1"},{"storageKey":"item-tile-layer/s2"}]}'),
        ($4, 'item-file/ref', '{}'),
        ($5, NULL, '{"storageKey":"","publicImageKey":"item-thumb/picked"}')`,
      [fileItem, tileItem, mosaicItem, refItem, pickerItem],
    );
    await admin.query(
      `INSERT INTO feature_attachment (id, storage_key) VALUES ($1, 'feature-attachment/p')`,
      [attachment],
    );
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }, { schema }),
    });
    prisma = client as unknown as PrismaService;
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('finds every place an item or attachment names a key', async () => {
    for (const key of [
      'item-file/a',
      'item-tile-layer/src',
      'item-tile-layer/cog',
      'item-tile-layer/pm',
      'item-tile-layer/s2',
      'item-file/ref',
      'item-thumb/picked',
      'feature-attachment/p',
    ]) {
      expect(await isKeyReferencedElsewhere(prisma, key)).toBe(true);
    }
    expect(await isKeyReferencedElsewhere(prisma, 'item-file/nobody')).toBe(false);
  });

  it('ignores the excepted item or attachment', async () => {
    expect(
      await isKeyReferencedElsewhere(prisma, 'item-tile-layer/cog', { itemId: tileItem }),
    ).toBe(false);
    expect(
      await isKeyReferencedElsewhere(prisma, 'feature-attachment/p', { attachmentId: attachment }),
    ).toBe(false);
    // A copy in a second item keeps the object alive when the first goes.
    await admin.query(
      `INSERT INTO ${schema}.item (id, data_json) VALUES ($1, '{"storageKey":"item-file/a"}')`,
      [randomUUID()],
    );
    expect(
      await isKeyReferencedElsewhere(prisma, 'item-file/a', { itemId: fileItem }),
    ).toBe(true);
  });

  it('a key is attachable only by the user it was issued to', async () => {
    await recordUploadGrant(prisma, 'item-file', 'item-file/new', victim);
    await expect(
      assertKeysAttachable(prisma, victim, ['item-file/new']),
    ).resolves.toBeUndefined();
    await expect(
      assertKeysAttachable(prisma, attacker, ['item-file/new']),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertKeysAttachable(prisma, attacker, ['item-file/a']),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Already on the target: allowed without a grant.
    await expect(
      assertKeysAttachable(prisma, attacker, ['item-file/a'], ['item-file/a']),
    ).resolves.toBeUndefined();
  });

  it('public kinds are not recorded, and old grants are pruned', async () => {
    await recordUploadGrant(prisma, 'group-thumb', 'group-thumb/x', victim);
    await admin.query(
      `INSERT INTO ${schema}.storage_upload_grant (key, user_id, created_at)
       VALUES ('item-file/old', $1, now() - interval '3 days')`,
      [victim],
    );
    await recordUploadGrant(prisma, 'item-file', 'item-file/newer', victim);
    const { rows } = await admin.query(
      `SELECT key FROM ${schema}.storage_upload_grant ORDER BY key`,
    );
    expect(rows.map((r: { key: string }) => r.key)).toEqual([
      'item-file/new',
      'item-file/newer',
    ]);
  });

  it('records item-thumb grants for the asset picker', async () => {
    await recordUploadGrant(prisma, 'item-thumb', 'item-thumb/mine', victim);
    await expect(
      assertKeysAttachable(prisma, victim, ['item-thumb/mine']),
    ).resolves.toBeUndefined();
    await expect(
      assertKeysAttachable(prisma, attacker, ['item-thumb/mine']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
