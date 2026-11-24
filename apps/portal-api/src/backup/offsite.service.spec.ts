// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { BadRequestException, Logger } from '@nestjs/common';

import { _resetKeyCacheForTests } from '../items/credential-cipher.js';
import { FakeS3 } from '../testing/fake-s3.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import type { BackupService } from './backup.service.js';
import { sealedSize, unsealStream } from './offsite-crypto.js';
import { OffsiteService } from './offsite.service.js';

const SECRET = 'S3CR3T-access-key-value-0001';
const PASS = 'my long offsite passphrase 0002';
const DAY = 24 * 60 * 60 * 1000;

async function collect(it: AsyncIterable<unknown>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(Buffer.from(b as Buffer));
  return Buffer.concat(out);
}

describe('OffsiteService', () => {
  const ENV_KEYS = [
    'BACKUP_OFFSITE_ENABLED',
    'BACKUP_OFFSITE_ENDPOINT',
    'BACKUP_OFFSITE_BUCKET',
    'BACKUP_OFFSITE_ACCESS_KEY_ID',
    'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
    'BACKUP_OFFSITE_PASSPHRASE',
    'BACKUP_OFFSITE_RETENTION_DAYS',
    'CREDENTIAL_ENCRYPTION_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let s3: FakeS3;
  let runs: Row[];
  let configRow: Row;
  let notice: { announceOffsite: jest.Mock };
  let svc: OffsiteService;
  let logged: string[];
  const archiveText =
    'PGDMP plaintext organization rows that must never be readable off-site\n'.repeat(50);

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      BACKUP_OFFSITE_ENABLED: 'true',
      BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
      BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
      BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BACKUP_OFFSITE_SECRET_ACCESS_KEY: SECRET,
      BACKUP_OFFSITE_PASSPHRASE: PASS,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    delete process.env.BACKUP_OFFSITE_RETENTION_DAYS;
    _resetKeyCacheForTests();

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-offsite-'));
    fs.writeFileSync(path.join(dir, 'backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz'), archiveText);
    runs = [
      {
        id: 'run-1',
        status: 'succeeded',
        filename: 'backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz',
        archiveDirectory: dir,
        startedAt: new Date('2026-11-24T02:00:00Z'),
        offsiteStatus: null,
        offsiteStartedAt: null,
        offsiteFinishedAt: null,
        offsiteHeartbeatAt: null,
      },
    ];
    configRow = emptyConfigRow();
    s3 = new FakeS3();
    notice = { announceOffsite: jest.fn().mockResolvedValue(true) };
    const backup = {
      configRow: jest.fn(async () => configRow),
      getConfig: jest.fn(async () => ({ archiveDirectory: dir })),
      onRunSucceeded: jest.fn(),
    } as unknown as BackupService;
    svc = new OffsiteService(makePrisma(runs, configRow) as never, backup, notice as never);
    svc.clientFactory = () => s3;
    svc.sealCost = 14;

    logged = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetKeyCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runUpload(objectBytes: number | null = 10) {
    const pending: unknown = await svc.startUpload('run-1', objectBytes);
    if (pending instanceof Promise) await pending;
  }

  it('uploads an encrypted copy that decrypts back to the archive, with a sidecar', async () => {
    await runUpload();
    const run = runs[0]!;
    expect(run.offsiteStatus).toBe('succeeded');
    expect(run.offsiteMode).toBe('archive');
    const key = 'gratisgis/archives/backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz.enc';
    expect(run.offsiteKey).toBe(key);
    expect(Number(run.offsiteBytes)).toBe(sealedSize(Buffer.byteLength(archiveText)));
    const stored = s3.objects.get(key)!.body;
    expect(stored.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(stored.includes(Buffer.from('organization rows'))).toBe(false);
    const plain = await collect(unsealStream(Readable.from([stored]), PASS));
    expect(plain.toString()).toBe(archiveText);
    const sidecar = JSON.parse(s3.objects.get(`${key}.json`)!.body.toString()) as {
      sealedSha256: string;
    };
    expect(sidecar.sealedSha256).toBe(run.offsiteSha256);
    // The passphrase and the secret are never written to the bucket.
    for (const o of s3.objects.values()) {
      expect(o.body.includes(Buffer.from(PASS))).toBe(false);
      expect(o.body.includes(Buffer.from(SECRET))).toBe(false);
    }
  });

  it('wrong credentials: marks the copy failed, raises a notice, keeps the local archive', async () => {
    s3.failAll('InvalidAccessKeyId', 403);
    await runUpload();
    const run = runs[0]!;
    expect(run.status).toBe('succeeded');
    expect(run.offsiteStatus).toBe('failed');
    expect(run.offsiteError).toMatch(/access key or secret/);
    expect(notice.announceOffsite).toHaveBeenCalledWith('failed:run-1', {
      runId: 'run-1',
      kind: 'offsite_failed',
    });
    expect(fs.existsSync(path.join(dir, String(run.filename)))).toBe(true);
  });

  it('never logs or stores a secret, even when an error message echoes one', async () => {
    s3.failAll(`Odd error mentioning ${SECRET} and ${PASS}`, 500);
    await runUpload();
    await svc.testConnection();
    const run = runs[0]!;
    expect(String(run.offsiteError)).not.toContain(SECRET);
    expect(String(run.offsiteError)).not.toContain(PASS);
    expect(String(run.offsiteError)).toContain('[redacted]');
    for (const line of logged) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(PASS);
    }
  });

  it('never returns a secret from the API view', async () => {
    await svc.updateConfig(
      {
        secretAccessKey: 'db-only-secret-9999',
        passphrase: 'database passphrase 1234',
        passphraseConfirm: 'database passphrase 1234',
      },
      null,
    );
    const view = await svc.getPublicConfig();
    const json = JSON.stringify(view);
    for (const s of [SECRET, PASS, 'db-only-secret-9999', 'database passphrase 1234']) {
      expect(json).not.toContain(s);
    }
    expect(view.hasSecretAccessKey).toBe(true);
    expect(view.secretAccessKeySource).toBe('database');
    // Stored encrypted, not in clear.
    expect(String(configRow.offsiteSecretEncrypted)).not.toContain('db-only-secret-9999');
    expect(String(configRow.offsitePassphraseEncrypted)).not.toContain('database passphrase');
    for (const line of logged) expect(line).not.toContain('db-only-secret-9999');
  });

  it('asks for the secret again when the endpoint changes', async () => {
    await svc.updateConfig(
      {
        endpoint: 'https://a.example.test',
        accessKeyId: 'AK1',
        secretAccessKey: 'first-secret-value',
      },
      null,
    );
    await expect(svc.updateConfig({ endpoint: 'https://b.example.test' }, null)).rejects.toThrow(
      /secret access key again/,
    );
    await expect(
      svc.updateConfig(
        { endpoint: 'https://b.example.test', secretAccessKey: 'second-secret-value' },
        null,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to turn on with settings missing', async () => {
    delete process.env.BACKUP_OFFSITE_PASSPHRASE;
    delete process.env.BACKUP_OFFSITE_ENABLED;
    await expect(svc.updateConfig({ enabled: true }, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does nothing when off-site is off', async () => {
    process.env.BACKUP_OFFSITE_ENABLED = 'false';
    await runUpload();
    expect(runs[0]!.offsiteStatus).toBeNull();
    expect(s3.calls).toHaveLength(0);
  });

  it('one upload per run at a time', async () => {
    runs[0]!.offsiteStatus = 'running';
    runs[0]!.offsiteHeartbeatAt = new Date();
    expect(await svc.startUpload('run-1', 10)).toBeUndefined();
    await expect(svc.retry('run-1')).rejects.toThrow(/already running/);
  });

  it('retention removes old copies and keeps the newest good one', async () => {
    const now = Date.now();
    const put = (name: string, ageDays: number) => {
      s3.objects.set(`gratisgis/archives/${name}`, {
        body: Buffer.from('x'),
        lastModified: new Date(now - ageDays * DAY),
        etag: '"x"',
      });
    };
    const stamp = (d: number) =>
      new Date(now - d * DAY).toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const newest = `backup-${stamp(40)}-11111111.tar.gz.enc`;
    const older = `backup-${stamp(50)}-22222222.tar.gz.enc`;
    const partial = `backup-${stamp(35)}-33333333.tar.gz.enc`;
    put(newest, 40);
    put(`${newest}.json`, 40);
    put(older, 50);
    put(`${older}.json`, 50);
    put(partial, 35);
    s3.objects.set('gratisgis/unrelated.txt', {
      body: Buffer.from('x'),
      lastModified: new Date(0),
      etag: '"x"',
    });
    const s = await svc.settings();
    const removed = await svc.enforceRetention(s, s3);
    expect(removed).toBe(3);
    const left = [...s3.objects.keys()].sort();
    expect(left).toEqual(
      [
        `gratisgis/archives/${newest}`,
        `gratisgis/archives/${newest}.json`,
        'gratisgis/unrelated.txt',
      ].sort(),
    );
  });

  it('raises the quiet-period notice once the alert window passes', async () => {
    runs[0]!.offsiteStatus = 'succeeded';
    runs[0]!.offsiteStartedAt = new Date(Date.now() - 10 * DAY);
    runs[0]!.offsiteFinishedAt = new Date(Date.now() - 5 * DAY);
    const key = await svc.checkStale();
    expect(key).toBe('stale:run-1');
    expect(notice.announceOffsite).toHaveBeenCalledWith('stale:run-1', {
      kind: 'offsite_stale',
      days: 5,
    });
  });

  it('closes out an upload whose process died', async () => {
    runs[0]!.offsiteStatus = 'running';
    runs[0]!.offsiteHeartbeatAt = new Date(Date.now() - 60 * 60 * 1000);
    expect(await svc.reclaimInterrupted()).toBe(1);
    expect(runs[0]!.offsiteStatus).toBe('failed');
  });

  it('connection test writes, lists and deletes one file', async () => {
    const res = await svc.testConnection();
    expect(res.ok).toBe(true);
    expect(s3.calls).toEqual(['PutObjectCommand', 'ListObjectsV2Command', 'DeleteObjectCommand']);
    expect(s3.objects.size).toBe(0);
  });

  it('connection test reports clock skew in plain words', async () => {
    s3.failAll('RequestTimeTooSkewed', 403);
    const res = await svc.testConnection();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/clock/);
  });
});
