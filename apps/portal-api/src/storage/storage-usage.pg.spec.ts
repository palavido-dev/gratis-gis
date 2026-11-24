// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The storage usage ledger against Postgres, with the real
// StorageService over an in-memory S3: uploads, replaces and deletes
// move the totals; parallel uploads add up exactly; the client's
// declared size is ignored; the backfill and the reconcile find and
// repair drift; and two orgs' numbers never mix.

import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { MemoryS3, withMemoryS3 } from '../testing/memory-s3.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import { ObjectKeyRefusedError, storageKey } from './object-keys.js';
import { LEDGER_FILLED_SETTING, StorageLedgerService } from './storage-ledger.service.js';
import { StorageUsageReconcileService } from './storage-usage-reconcile.service.js';
import { StorageService } from './storage.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the storage usage pg suite would skip.',
  );
}

jest.setTimeout(180_000);

const MIGRATIONS = join(__dirname, '../../prisma/migrations');
const ORG_A = '5a000000-0000-4000-8000-00000000000a';
const ORG_B = '5b000000-0000-4000-8000-00000000000b';
const USER_A = '5a000000-0000-4000-8000-0000000000a1';
const ITEM_A = '5a000000-0000-4000-8000-0000000000f1';
const USER_B = '5b000000-0000-4000-8000-0000000000b1';
const DB = `gg_storage_usage_${process.pid}`;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('storage usage ledger against Postgres', () => {
  let url: string;
  let pool: Pool;
  let client: PrismaClient;
  let prisma: PrismaService;
  let ledger: StorageLedgerService;
  let storage: StorageService;
  let s3: MemoryS3;
  let reconcile: StorageUsageReconcileService;

  const totals = async (org: string): Promise<{ bytes: number; objects: number }> => {
    const r = await pool.query<{ bytes: string; objects: string }>(
      'SELECT bytes, objects FROM org_storage_usage WHERE org_id = $1',
      [org],
    );
    return { bytes: Number(r.rows[0]?.bytes ?? 0), objects: Number(r.rows[0]?.objects ?? 0) };
  };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    url = databaseUrl(TEST_URL!, DB);
    applyTestMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url, max: 4 });
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'a', 'A'), ($2, 'b', 'B')`,
      [ORG_A, ORG_B],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'a', 'a@example.test', 'A', 'admin')`,
      [USER_A, ORG_A],
    );
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 8 }) });
    prisma = client as unknown as PrismaService;
    ledger = new StorageLedgerService(prisma);
    s3 = new MemoryS3();
    storage = withMemoryS3(new StorageService(new ConfigService(), ledger), s3);
    reconcile = new StorageUsageReconcileService(prisma, storage, ledger);
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  });

  it('upload, replace and delete move the totals up, keep them right, and down', async () => {
    const before = await totals(ORG_A);
    const { key } = await storage.uploadBuffer('item-file', { orgId: ORG_A }, Buffer.alloc(1000));
    expect(await totals(ORG_A)).toEqual({
      bytes: before.bytes + 1000,
      objects: before.objects + 1,
    });
    // Replace in place (same key, new bytes), as a re-upload or a
    // reconcile that finds a new size would record it.
    s3.put(key, Buffer.alloc(400));
    await storage.recordUploaded(key, { orgId: ORG_A });
    expect(await totals(ORG_A)).toEqual({ bytes: before.bytes + 400, objects: before.objects + 1 });
    // Recording again changes nothing.
    await storage.recordUploaded(key, { orgId: ORG_A });
    expect(await totals(ORG_A)).toEqual({ bytes: before.bytes + 400, objects: before.objects + 1 });
    await storage.deleteObject(key, { orgId: ORG_A });
    expect(await totals(ORG_A)).toEqual(before);
    // A second delete is a no-op.
    await storage.deleteObject(key, { orgId: ORG_A });
    expect(await totals(ORG_A)).toEqual(before);
  });

  it('twenty parallel uploads end with the exact sum', async () => {
    const before = await totals(ORG_A);
    const sizes = Array.from({ length: 20 }, (_, i) => 100 + i * 37);
    await Promise.all(
      sizes.map((n) => storage.uploadBuffer('item-file', { orgId: ORG_A }, Buffer.alloc(n))),
    );
    const sum = sizes.reduce((a, b) => a + b, 0);
    expect(await totals(ORG_A)).toEqual({
      bytes: before.bytes + sum,
      objects: before.objects + 20,
    });
  });

  it('charges the size in the store, not the size the client declared', async () => {
    const before = await totals(ORG_A);
    // The client presigned 10 bytes; the object holds 5000 (a store
    // that did not enforce the signed length). The ledger reads the store.
    const presigned = await storage.presignUpload('item-file', { orgId: ORG_A }, 'text/plain', 10);
    s3.put(presigned.key, Buffer.alloc(5000));
    const size = await storage.recordUploaded(presigned.key, { orgId: ORG_A }, { itemId: ITEM_A });
    expect(size).toBe(5000);
    expect((await totals(ORG_A)).bytes).toBe(before.bytes + 5000);
  });

  it("never records or removes an object for another org's owner", async () => {
    const aBefore = await totals(ORG_A);
    const bBefore = await totals(ORG_B);
    const { key } = await storage.uploadBuffer('item-file', { orgId: ORG_A }, Buffer.alloc(77));
    await expect(storage.recordUploaded(key, { orgId: ORG_B })).rejects.toThrow();
    await expect(storage.deleteObject(key, { orgId: ORG_B })).rejects.toThrow();
    // The ledger itself will not move a row between orgs either.
    expect(await ledger.record({ key, orgId: ORG_B, kind: 'item-file', bytes: 1 })).toBe(0);
    expect(await ledger.markDeleted(key, ORG_B)).toBe(0);
    expect(await totals(ORG_B)).toEqual(bBefore);
    expect(await totals(ORG_A)).toEqual({
      bytes: aBefore.bytes + 77,
      objects: aBefore.objects + 1,
    });
  });

  it('backfill: a dry run reports the right totals, a real run fills them, a second run changes nothing', async () => {
    // Objects stored before the ledger: an older-layout file an item
    // names, an attachment, and one nothing refers to.
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'file', 'old', $4::jsonb, now())`,
      [
        ITEM_A,
        ORG_A,
        USER_A,
        JSON.stringify({ storageKey: 'item-file/0f8fad5b-d9cb-469f-a165-70867728950e' }),
      ],
    );
    s3.put('item-file/0f8fad5b-d9cb-469f-a165-70867728950e', Buffer.alloc(3000));
    s3.put('item-file/1f8fad5b-d9cb-469f-a165-70867728950e', Buffer.alloc(11));
    const before = await totals(ORG_A);

    const dry = await reconcile.reconcile({ dryRun: true, log: () => undefined });
    expect(dry.recorded).toBe(1);
    expect(dry.unattributed).toBe(1);
    expect(dry.unattributedSample).toEqual(['item-file/1f8fad5b-d9cb-469f-a165-70867728950e']);
    expect(await totals(ORG_A)).toEqual(before);

    const real = await reconcile.reconcile({ dryRun: false, log: () => undefined });
    expect(real.recorded).toBe(1);
    expect(await totals(ORG_A)).toEqual({
      bytes: before.bytes + 3000,
      objects: before.objects + 1,
    });
    // The unattributed object is still there: reported, never deleted.
    expect(s3.objects.has('item-file/1f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);

    const again = await reconcile.reconcile({ dryRun: false, log: () => undefined });
    expect(again.recorded + again.resized + again.markedDeleted).toBe(0);
    expect(await totals(ORG_A)).toEqual({
      bytes: before.bytes + 3000,
      objects: before.objects + 1,
    });
    const last = await reconcile.lastSummary();
    expect(last?.finishedAt).toBeTruthy();
  });

  it('backfill resumes from where a limited run stopped', async () => {
    s3.pageSize = 2;
    try {
      const first = await reconcile.reconcile({ dryRun: true, maxPages: 1, log: () => undefined });
      expect(first.resumeAfter).not.toBeNull();
      const rest = await reconcile.reconcile({
        dryRun: true,
        startAfter: first.resumeAfter!,
        log: () => undefined,
      });
      const all = await reconcile.reconcile({ dryRun: true, log: () => undefined });
      expect(first.objectsSeen + rest.objectsSeen).toBe(all.objectsSeen);
    } finally {
      s3.pageSize = 1000;
    }
  });

  it('reconcile repairs an object deleted behind its back and one added behind its back', async () => {
    const { key: gone } = await storage.uploadBuffer(
      'item-file',
      { orgId: ORG_B },
      Buffer.alloc(500),
    );
    // Backdate the row so it predates the reconcile's walk.
    await pool.query(
      `UPDATE storage_object SET created_at = now() - interval '1 hour' WHERE key = $1`,
      [gone],
    );
    const before = await totals(ORG_B);
    s3.objects.delete(gone); // removed directly in the store
    const added = storageKey('item-file', ORG_B);
    s3.put(added, Buffer.alloc(70)); // written directly to the store

    const r = await reconcile.reconcile({ dryRun: false, log: () => undefined });
    expect(r.markedDeleted).toBeGreaterThanOrEqual(1);
    expect(r.recorded).toBeGreaterThanOrEqual(1);
    expect(await totals(ORG_B)).toEqual({
      bytes: before.bytes - 500 + 70,
      objects: before.objects,
    });
    const row = await pool.query<{ drift_bytes: string; reconciled_at: Date | null }>(
      'SELECT drift_bytes, reconciled_at FROM org_storage_usage WHERE org_id = $1',
      [ORG_B],
    );
    expect(Number(row.rows[0]!.drift_bytes)).toBe(-430);
    expect(row.rows[0]!.reconciled_at).not.toBeNull();
  });

  it('reconcile puts totals that drifted from their rows back to the sum', async () => {
    await pool.query(`UPDATE org_storage_usage SET bytes = bytes + 999999 WHERE org_id = $1`, [
      ORG_A,
    ]);
    await reconcile.reconcile({ dryRun: false, log: () => undefined });
    const sum = await pool.query<{ b: string }>(
      `SELECT COALESCE(SUM(bytes), 0) AS b FROM storage_object WHERE org_id = $1 AND deleted_at IS NULL`,
      [ORG_A],
    );
    expect((await totals(ORG_A)).bytes).toBe(Number(sum.rows[0]!.b));
  });

  it('usage reads one org only, by kind', async () => {
    const a = await ledger.usage(ORG_A);
    const b = await ledger.usage(ORG_B);
    expect(a.byKind.reduce((n, k) => n + k.bytes, 0)).toBe(a.objectBytes);
    expect(b.byKind.reduce((n, k) => n + k.bytes, 0)).toBe(b.objectBytes);
    const keysB = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM storage_object WHERE org_id = $1 AND key LIKE $2`,
      [ORG_B, `%/o/${ORG_A}/%`],
    );
    expect(Number(keysB.rows[0]!.n)).toBe(0);
  });

  it('a completed real reconcile writes the fill marker; a dry run or a stopped walk does not', async () => {
    await pool.query(`DELETE FROM system_setting WHERE key = $1`, [LEDGER_FILLED_SETTING]);
    const freshLedger = new StorageLedgerService(prisma);
    const fresh = new StorageUsageReconcileService(
      prisma,
      withMemoryS3(new StorageService(new ConfigService(), freshLedger), s3),
      freshLedger,
    );
    const marker = async () =>
      (await pool.query(`SELECT 1 FROM system_setting WHERE key = $1`, [LEDGER_FILLED_SETTING]))
        .rowCount;
    await fresh.reconcile({ dryRun: true, log: () => undefined });
    expect(await marker()).toBe(0);
    s3.pageSize = 1;
    try {
      const stopped = await fresh.reconcile({ dryRun: false, maxPages: 1, log: () => undefined });
      expect(stopped.resumeAfter).not.toBeNull();
    } finally {
      s3.pageSize = 1000;
    }
    expect(await marker()).toBe(0);
    await expect(freshLedger.ledgerFilled()).resolves.toBe(false);
    await fresh.reconcile({ dryRun: false, log: () => undefined });
    expect(await marker()).toBe(1);
    await expect(freshLedger.ledgerFilled()).resolves.toBe(true);
  });

  it('where an org is required, an older key with no row is served until the first fill, then refused', async () => {
    const before = process.env.GRATIS_TENANCY;
    process.env.GRATIS_TENANCY = 'multi';
    resetTenancyModeForTests();
    try {
      await pool.query(`DELETE FROM system_setting WHERE key = $1`, [LEDGER_FILLED_SETTING]);
      const l2 = new StorageLedgerService(prisma);
      const st2 = withMemoryS3(new StorageService(new ConfigService(), l2), s3);
      const r2 = new StorageUsageReconcileService(prisma, st2, l2);
      const older = 'item-file/2f8fad5b-d9cb-469f-a165-70867728950e';
      s3.put(older, Buffer.alloc(9));
      // Not filled yet: the older behaviour (item checks only).
      await expect(st2.headObjectSize(older, { orgId: ORG_A })).resolves.toBe(9);
      // The first fill finds no owner for it, so it stays unknown.
      await r2.reconcile({ dryRun: false, log: () => undefined });
      await expect(l2.ledgerFilled()).resolves.toBe(true);
      await expect(st2.headObjectSize(older, { orgId: ORG_A })).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
      // Once an item names it, the next reconcile records its owner.
      await pool.query(
        `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
         VALUES ('5a000000-0000-4000-8000-0000000000f2', $1, $2, 'file', 'older', $3::jsonb, now())`,
        [ORG_A, USER_A, JSON.stringify({ storageKey: older })],
      );
      await r2.reconcile({ dryRun: false, log: () => undefined });
      await expect(st2.headObjectSize(older, { orgId: ORG_A })).resolves.toBe(9);
      await expect(st2.headObjectSize(older, { orgId: ORG_B })).rejects.toBeInstanceOf(
        ObjectKeyRefusedError,
      );
    } finally {
      if (before === undefined) delete process.env.GRATIS_TENANCY;
      else process.env.GRATIS_TENANCY = before;
      resetTenancyModeForTests();
    }
  });

  it('a store error while checking for missing objects marks nothing deleted', async () => {
    const { key } = await storage.uploadBuffer('item-file', { orgId: ORG_B }, Buffer.alloc(31));
    await pool.query(
      `UPDATE storage_object SET created_at = now() - interval '1 hour' WHERE key = $1`,
      [key],
    );
    s3.objects.delete(key);
    const send = s3.send.bind(s3);
    s3.send = async (cmd: Parameters<MemoryS3['send']>[0]) => {
      if (cmd.constructor.name === 'HeadObjectCommand') {
        throw Object.assign(new Error('connect ETIMEDOUT'), { name: 'TimeoutError' });
      }
      return send(cmd);
    };
    try {
      const r = await reconcile.reconcile({ dryRun: false, log: () => undefined });
      expect(r.checkAborted).toContain(ORG_B);
      const row = await pool.query(`SELECT deleted_at FROM storage_object WHERE key = $1`, [key]);
      expect(row.rows[0]!.deleted_at).toBeNull();
    } finally {
      s3.send = send;
    }
    // With the store answering again, the gone object is marked deleted.
    const r = await reconcile.reconcile({ dryRun: false, log: () => undefined });
    expect(r.checkAborted ?? []).not.toContain(ORG_B);
    const row = await pool.query(`SELECT deleted_at FROM storage_object WHERE key = $1`, [key]);
    expect(row.rows[0]!.deleted_at).not.toBeNull();
  });

  it('a public image URL stored on two rows is counted for the row that stored it first', async () => {
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'b', 'b@example.test', 'B', 'admin') ON CONFLICT DO NOTHING`,
      [USER_B, ORG_B],
    );
    const thumb = 'item-thumb/3f8fad5b-d9cb-469f-a165-70867728950e';
    const url = `http://localhost:9000/gratisgis/${thumb}`;
    // The later row (org B) is inserted first, so table order alone
    // would not decide.
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, thumbnail_url, created_at, updated_at)
       VALUES ('5b000000-0000-4000-8000-0000000000f3', $1, $2, 'file', 'copy', '{}'::jsonb, $3, now(), now()),
              ('5a000000-0000-4000-8000-0000000000f3', $4, $5, 'file', 'first', '{}'::jsonb, $3, now() - interval '1 day', now())`,
      [ORG_B, USER_B, url, ORG_A, USER_A],
    );
    s3.put(thumb, Buffer.alloc(5));
    await reconcile.reconcile({ dryRun: false, log: () => undefined });
    const row = await pool.query<{ org_id: string }>(
      `SELECT org_id FROM storage_object WHERE key = $1`,
      [thumb],
    );
    expect(row.rows[0]!.org_id).toBe(ORG_A);
  });
});
