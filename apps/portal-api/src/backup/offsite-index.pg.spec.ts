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
import { checkSignature, parseVerifyKey } from './offsite-sign.js';
import { BackupRestoreService } from './backup-restore.service.js';
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
    await pool.query('DELETE FROM backup_offsite_mirror_run');
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

  it('a restore inside the portal keeps the live off-site settings and empties the mirror index', async () => {
    await pool.query('DELETE FROM backup_config');
    const live = generateOffsiteKeyPair().publicKey.text;
    const old = generateOffsiteKeyPair().publicKey.text;
    await pool.query(
      `INSERT INTO backup_config (id, offsite_enabled, offsite_public_key, offsite_install_id, offsite_prefix)
       VALUES ($1, true, $2, 'live-install', 'live/')`,
      [randomUUID(), live],
    );
    const svc = new BackupRestoreService(
      prisma as unknown as PrismaService,
      { get: (_k: string, d?: string) => d } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const history = await svc.snapshotBackupHistory();
    // What pg_restore of an older archive leaves behind.
    await pool.query(
      `UPDATE backup_config SET offsite_public_key = $1, offsite_install_id = 'old-install', offsite_prefix = 'old/'`,
      [old],
    );
    await pool.query(
      `INSERT INTO backup_offsite_object (target, name, source, key_fingerprint, plain_bytes, sealed_bytes, last_run_at)
       VALUES ('t', 'n', 's', 'f', 1, 2, now() - interval '90 days')`,
    );
    await pool.query(`INSERT INTO backup_offsite_mirror_run (target, run_id) VALUES ('t', 'r')`);
    await svc.restoreBackupHistory(history);
    const row = (
      await pool.query<{ k: string; i: string; p: string }>(
        'SELECT offsite_public_key AS k, offsite_install_id AS i, offsite_prefix AS p FROM backup_config',
      )
    ).rows[0]!;
    expect(row).toEqual({ k: live, i: 'live-install', p: 'live/' });
    expect((await pool.query('SELECT 1 FROM backup_offsite_object')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM backup_offsite_mirror_run')).rowCount).toBe(0);
    await pool.query('DELETE FROM backup_config');
  });

  it('a restore inside the portal never brings back the signing key from the archive', async () => {
    await pool.query('DELETE FROM backup_config');
    const svc = new BackupRestoreService(
      prisma as unknown as PrismaService,
      { get: (_k: string, d?: string) => d } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // Live server with a signing key; the archive holds another one.
    await pool.query(
      `INSERT INTO backup_config (id, offsite_signing_key_encrypted, offsite_signing_key_iv, offsite_verify_key, offsite_previous_verify_keys)
       VALUES ($1, 'live-ct', 'live-iv', 'ggver1:live', ARRAY['ggver1:older'])`,
      [randomUUID()],
    );
    let history = await svc.snapshotBackupHistory();
    await pool.query(
      `UPDATE backup_config SET offsite_signing_key_encrypted = 'dump-ct', offsite_signing_key_iv = 'dump-iv', offsite_verify_key = 'ggver1:dump', offsite_previous_verify_keys = ARRAY[]::text[]`,
    );
    await svc.restoreBackupHistory(history);
    const read = async () =>
      (
        await pool.query<{ c: string | null; v: string | null; p: string[] | null }>(
          'SELECT offsite_signing_key_encrypted AS c, offsite_verify_key AS v, offsite_previous_verify_keys AS p FROM backup_config',
        )
      ).rows[0]!;
    expect(await read()).toEqual({ c: 'live-ct', v: 'ggver1:live', p: ['ggver1:older'] });

    // Live server with no signing key yet: the archive's is not kept
    // either, so the server makes a new one.
    await pool.query(
      `UPDATE backup_config SET offsite_signing_key_encrypted = NULL, offsite_signing_key_iv = NULL, offsite_verify_key = NULL`,
    );
    history = await svc.snapshotBackupHistory();
    await pool.query(
      `UPDATE backup_config SET offsite_signing_key_encrypted = 'dump-ct', offsite_signing_key_iv = 'dump-iv', offsite_verify_key = 'ggver1:dump'`,
    );
    await svc.restoreBackupHistory(history);
    expect(await read()).toMatchObject({ c: null, v: null });
    await pool.query('DELETE FROM backup_config');
  });

  it('the local index records, finds, moves forward and removes rows', async () => {
    const index = new PrismaMirrorIndex(prisma as never);
    const t1 = new Date('2026-11-01T00:00:00Z');
    const t2 = new Date('2026-11-10T00:00:00Z');
    const t3 = new Date('2026-11-12T00:00:00Z');
    const row = (name: string, source: string, lastRunAt: Date, extra = {}) => ({
      name,
      source,
      keyFingerprint: 'fp',
      plainBytes: 3,
      sealedBytes: 134,
      sealedSha256: 'a'.repeat(64),
      contentType: 'text/plain',
      lastRunAt,
      ...extra,
    });
    await index.record('target-a', row('n1.enc', 's1', t1));
    await index.record(
      'target-a',
      row('n2.enc', 's2', t1, {
        plainBytes: 5 * GB,
        sealedBytes: 5 * GB + 200_000,
        sealedSha256: null,
        contentType: null,
      }),
    );
    await index.record('target-b', row('n1.enc', 's1', t1, { sealedSha256: 'b'.repeat(64) }));
    const found = await index.find('target-a', ['s1', 's2', 'missing']);
    expect([...found.keys()].sort()).toEqual(['s1', 's2']);
    expect(found.get('s2')!.plainBytes).toBe(5 * GB);
    expect(found.get('s1')!.name).toBe('n1.enc');
    expect(found.get('s1')!.contentType).toBe('text/plain');
    expect(found.get('s1')!.sealedSha256).toBe('a'.repeat(64));
    expect(found.get('s2')!.sealedSha256).toBeNull();
    // A second upload of the same source gets its own row; find gives
    // the newest, and the older row stays until clean-up.
    await index.record('target-a', row('n3.enc', 's1', t3));
    expect((await index.find('target-a', ['s1'])).get('s1')!.name).toBe('n3.enc');
    expect([...(await index.known('target-a', ['n1.enc', 'n3.enc', 'x.enc']))].sort()).toEqual([
      'n1.enc',
      'n3.enc',
    ]);

    await index.touch('target-a', ['n1.enc'], t2);
    // Never moves backwards.
    await index.touch('target-a', ['n1.enc'], t1);
    expect(await index.olderThan('target-a', new Date('2026-11-05T00:00:00Z'), 10)).toEqual([
      'n2.enc',
    ]);
    await index.remove('target-a', ['n2.enc']);
    expect((await index.find('target-a', ['s2'])).size).toBe(0);
    expect((await index.find('target-b', ['s1'])).size).toBe(1);

    // The record of mirror runs this server started.
    await index.recordRun('target-a', '2026-11-01T00-00-00-000-aaaaaaaa');
    await index.recordRun('target-a', '2026-11-01T00-00-00-000-aaaaaaaa');
    await index.recordRun('target-a', '2026-11-02T00-00-00-000-bbbbbbbb');
    await index.recordRun('target-b', '2026-11-03T00-00-00-000-cccccccc');
    expect([...(await index.runIds('target-a'))].sort()).toEqual([
      '2026-11-01T00-00-00-000-aaaaaaaa',
      '2026-11-02T00-00-00-000-bbbbbbbb',
    ]);
    await index.forgetRuns('target-a', ['2026-11-01T00-00-00-000-aaaaaaaa']);
    expect([...(await index.runIds('target-a'))]).toEqual(['2026-11-02T00-00-00-000-bbbbbbbb']);
    expect((await index.runIds('target-b')).size).toBe(1);
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
      // Both runs are signed by the server's own key, stored encrypted.
      expect(cfg.offsiteSigningKeyEncrypted).toBeTruthy();
      const verify = parseVerifyKey(cfg.offsiteVerifyKey!);
      for (const k of done) {
        const run = k.slice('pg/mirror/runs/'.length, -'/done.json'.length);
        const check = checkSignature(JSON.parse(remote.objects.get(k)!.body.toString()), [verify], {
          kind: 'mirror',
          prefix: 'pg/',
          name: run,
          installIds: [cfg.offsiteInstallId!],
        });
        expect(check.trust).toBe('verified');
      }
      const { rows: verifyRows } = await pool.query<{ v: string | null }>(
        'SELECT offsite_verify_fingerprint AS v FROM backup_run',
      );
      expect(verifyRows.every((r) => r.v === verify.fingerprintText)).toBe(true);
      // Reused files keep their recorded checksum.
      const sums = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM backup_offsite_object WHERE sealed_sha256 IS NOT NULL',
      );
      expect(sums.rows[0]!.n).toBe(2);
      // The signing key is never in the bucket, in any form.
      for (const o of remote.objects.values()) {
        expect(o.body.includes(Buffer.from(cfg.offsiteSigningKeyEncrypted!))).toBe(false);
      }
      const runsRecorded = await pool.query(
        'SELECT count(*)::int AS n FROM backup_offsite_mirror_run',
      );
      expect(runsRecorded.rows[0].n).toBe(2);

      // The index is emptied, as a restore does: the next run uploads
      // under new names and leaves every file already there as it was.
      const objectsPrefix = 'pg/mirror/objects/';
      const before = new Map(
        [...remote.objects.entries()]
          .filter(([k]) => k.startsWith(objectsPrefix))
          .map(([k, o]) => [k, Buffer.from(o.body)]),
      );
      await pool.query('TRUNCATE backup_offsite_object, backup_offsite_mirror_run');
      const r3 = await addRun(
        new Date(Date.now() - 3_600_000),
        'backup-2026-11-24T02-00-00-000-cccccccc.tar.gz',
      );
      execFileSync('tar', [
        '-czf',
        join(dir, 'backup-2026-11-24T02-00-00-000-cccccccc.tar.gz'),
        '-C',
        stage,
        'manifest.json',
        'postgres',
      ]);
      await (
        await svc.startUpload(r3, 100 * GB)
      )?.done;
      const third = [...remote.objects.keys()]
        .filter((k) => k.endsWith('done.json'))
        .sort()
        .at(-1)!;
      expect(JSON.parse(remote.objects.get(third)!.body.toString())).toMatchObject({
        uploaded: 2,
        reused: 0,
      });
      for (const [k, b] of before) expect(remote.objects.get(k)!.body.equals(b)).toBe(true);
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      _resetKeyCacheForTests();
    }
  });
});
