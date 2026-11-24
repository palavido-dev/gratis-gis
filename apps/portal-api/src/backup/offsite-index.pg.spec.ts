// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Off-site backups against a real PostgreSQL with every migration
 * applied: the one-upload-at-a-time index, the local index of mirrored
 * files through the real Prisma client, and a full mirror upload whose
 * second run reuses what the first one recorded.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { _resetKeyCacheForTests } from '../items/credential-cipher.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { FakeS3 } from '../testing/fake-s3.js';
import type { BackupService } from './backup.service.js';
import { generateOffsiteKeyPair } from './offsite-crypto.js';
import { PrismaMirrorIndex } from './offsite-mirror.js';
import { OffsiteService } from './offsite.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the off-site index pg suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_offsite_index';
const GB = 1024 ** 3;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('off-site backups against Postgres', () => {
  const dbUrl = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let prisma: PrismaClient;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'BACKUP_OFFSITE_ENABLED',
    'BACKUP_OFFSITE_ENDPOINT',
    'BACKUP_OFFSITE_BUCKET',
    'BACKUP_OFFSITE_PREFIX',
    'BACKUP_OFFSITE_ACCESS_KEY_ID',
    'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
    'BACKUP_OFFSITE_PUBLIC_KEY',
    'CREDENTIAL_ENCRYPTION_KEY',
  ];

  async function addRun(startedAt: Date, filename: string | null = null): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO backup_run (id, status, trigger, started_at, finished_at, filename, archive_directory)
       VALUES ($1, 'succeeded', 'manual', $2, $2, $3, $4)`,
      [id, startedAt, filename, dir],
    );
    return id;
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }) });
    dir = fs.mkdtempSync(join(os.tmpdir(), 'gg-offsite-pg-'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM backup_run');
    await pool.query('DELETE FROM backup_offsite_object');
  });

  it('allows at most one off-site upload marked running', async () => {
    const a = await addRun(new Date());
    const b = await addRun(new Date());
    await pool.query(`UPDATE backup_run SET offsite_status = 'running' WHERE id = $1`, [a]);
    await expect(
      pool.query(`UPDATE backup_run SET offsite_status = 'running' WHERE id = $1`, [b]),
    ).rejects.toThrow(/backup_run_one_offsite_running_idx/);
    // Prisma reports it as P2002, which the service treats as "busy".
    await expect(
      prisma.backupRun.updateMany({ where: { id: b }, data: { offsiteStatus: 'running' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await pool.query(`UPDATE backup_run SET offsite_status = 'succeeded' WHERE id = $1`, [a]);
    await pool.query(`UPDATE backup_run SET offsite_status = 'running' WHERE id = $1`, [b]);
  });

  it('allows at most one backup test marked running', async () => {
    await pool.query('DELETE FROM backup_restore_test');
    await prisma.backupRestoreTest.create({ data: { filename: 'a.tar.gz' } });
    // Prisma reports it as P2002, which the service turns into "already running".
    await expect(
      prisma.backupRestoreTest.create({ data: { filename: 'b.tar.gz' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await pool.query(`UPDATE backup_restore_test SET status = 'passed'`);
    await prisma.backupRestoreTest.create({ data: { filename: 'c.tar.gz' } });
    await pool.query('DELETE FROM backup_restore_test');
  });

  it('the local index records, finds, moves forward and removes rows', async () => {
    const index = new PrismaMirrorIndex(prisma as never);
    const t1 = new Date('2026-11-01T00:00:00Z');
    const t2 = new Date('2026-11-10T00:00:00Z');
    await index.record('target-a', {
      name: 'n1.enc',
      keyFingerprint: 'fp',
      plainBytes: 3,
      sealedBytes: 134,
      contentType: 'text/plain',
      lastRunAt: t1,
    });
    await index.record('target-a', {
      name: 'n2.enc',
      keyFingerprint: 'fp',
      plainBytes: 5 * GB,
      sealedBytes: 5 * GB + 200_000,
      contentType: null,
      lastRunAt: t1,
    });
    await index.record('target-b', {
      name: 'n1.enc',
      keyFingerprint: 'fp',
      plainBytes: 1,
      sealedBytes: 132,
      contentType: null,
      lastRunAt: t1,
    });
    const found = await index.find('target-a', ['n1.enc', 'n2.enc', 'missing.enc']);
    expect([...found.keys()].sort()).toEqual(['n1.enc', 'n2.enc']);
    expect(found.get('n2.enc')!.plainBytes).toBe(5 * GB);
    expect(found.get('n1.enc')!.contentType).toBe('text/plain');

    await index.touch('target-a', ['n1.enc'], t2);
    // Never moves backwards.
    await index.touch('target-a', ['n1.enc'], t1);
    expect((await index.find('target-a', ['n1.enc'])).get('n1.enc')!.lastRunAt).toEqual(t2);
    expect(await index.olderThan('target-a', new Date('2026-11-05T00:00:00Z'), 10)).toEqual([
      'n2.enc',
    ]);
    await index.remove('target-a', ['n2.enc']);
    expect((await index.find('target-a', ['n2.enc'])).size).toBe(0);
    expect((await index.find('target-b', ['n1.enc'])).size).toBe(1);
  });

  it('a mirror upload through the real database reuses what it recorded', async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    const key = generateOffsiteKeyPair();
    Object.assign(process.env, {
      BACKUP_OFFSITE_ENABLED: 'true',
      BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
      BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
      BACKUP_OFFSITE_PREFIX: 'pg/',
      BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'pg-secret-value-1',
      BACKUP_OFFSITE_PUBLIC_KEY: key.publicKey.text,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    _resetKeyCacheForTests();
    try {
      await pool.query('DELETE FROM backup_config');
      await pool.query(`INSERT INTO backup_config (id) VALUES (gen_random_uuid())`);
      const configRow = () => prisma.backupConfig.findFirstOrThrow();
      const source = new FakeS3();
      const remote = new FakeS3();
      for (const [k, body] of [
        ['a.txt', 'a'],
        ['b.txt', 'bb'],
      ]) {
        await source.send({
          constructor: { name: 'PutObjectCommand' },
          input: { Bucket: 'gratisgis', Key: k, Body: Buffer.from(body!) },
        } as never);
      }
      const stage = join(dir, 'stage');
      fs.mkdirSync(join(stage, 'postgres'), { recursive: true });
      fs.writeFileSync(
        join(stage, 'manifest.json'),
        JSON.stringify({ databases: ['gratisgis'], minio: { totalBytes: 100 * GB } }),
      );
      fs.writeFileSync(join(stage, 'postgres', 'gratisgis.dump'), randomBytes(1000));
      const names = [
        'backup-2026-11-22T02-00-00-000-aaaaaaaa.tar.gz',
        'backup-2026-11-23T02-00-00-000-bbbbbbbb.tar.gz',
      ];
      for (const n of names) {
        execFileSync('tar', ['-czf', join(dir, n), '-C', stage, 'manifest.json', 'postgres']);
      }
      const svc = new OffsiteService(
        prisma as unknown as PrismaService,
        {
          configRow,
          getConfig: async () => ({ archiveDirectory: dir }),
          onRunSucceeded: () => undefined,
          sourceStore: () => ({ s3: source, bucket: 'gratisgis' }),
        } as unknown as BackupService,
      );
      svc.clientFactory = () => remote;
      svc.endpointCheck = async () => undefined;

      const r1 = await addRun(new Date(Date.now() - 2 * 86_400_000), names[0]);
      await (
        await svc.startUpload(r1, 100 * GB)
      )?.done;
      const r2 = await addRun(new Date(Date.now() - 86_400_000), names[1]);
      await (
        await svc.startUpload(r2, 100 * GB)
      )?.done;

      const { rows } = await pool.query<{
        id: string;
        offsite_status: string;
        offsite_mode: string;
        offsite_key_fingerprint: string;
      }>(
        'SELECT id, offsite_status, offsite_mode, offsite_key_fingerprint FROM backup_run ORDER BY started_at',
      );
      expect(rows.map((r) => r.offsite_status)).toEqual(['succeeded', 'succeeded']);
      expect(rows.every((r) => r.offsite_mode === 'mirror')).toBe(true);
      expect(rows[1]!.offsite_key_fingerprint).toBe(key.publicKey.fingerprintText);
      const objects = await pool.query('SELECT count(*)::int AS n FROM backup_offsite_object');
      expect(objects.rows[0].n).toBe(2);
      const done = [...remote.objects.keys()].filter((k) => k.endsWith('done.json'));
      const second = JSON.parse(remote.objects.get(done.sort().at(-1)!)!.body.toString()) as {
        uploaded: number;
        reused: number;
      };
      expect(second).toMatchObject({ uploaded: 0, reused: 2 });
      const cfg = await configRow();
      expect(cfg.offsiteInstallId).toMatch(/^[0-9a-f-]{36}$/);
      expect(cfg.offsiteNameKeyEncrypted).toBeTruthy();
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      _resetKeyCacheForTests();
    }
  });
});
