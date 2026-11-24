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
import { dispatchRunSucceeded, type BackupService } from './backup.service.js';
import {
  generateOffsiteKeyPair,
  sealedSize,
  sealKeyFile,
  unsealStream,
  type OffsitePrivateKey,
} from './offsite-crypto.js';
import { OffsiteService } from './offsite.service.js';

const SECRET = 'S3CR3T-access-key-value-0001';
const KEY_PASS = 'my key file passphrase 0002';
const DAY = 24 * 60 * 60 * 1000;
const NAME1 = 'backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz';

async function collect(it: AsyncIterable<unknown>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(Buffer.from(b as Buffer));
  return Buffer.concat(out);
}

/** A fake store whose next multipart part or PUT waits until released. */
class SlowS3 extends FakeS3 {
  gate: Promise<void> | null = null;
  release: () => void = () => undefined;
  hold() {
    this.gate = new Promise((r) => {
      this.release = () => {
        this.gate = null;
        r();
      };
    });
  }
  override async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    if (this.gate && command.constructor.name === 'PutObjectCommand') await this.gate;
    return super.send(command);
  }
}

describe('OffsiteService', () => {
  const ENV_KEYS = [
    'BACKUP_OFFSITE_ENABLED',
    'BACKUP_OFFSITE_ENDPOINT',
    'BACKUP_OFFSITE_BUCKET',
    'BACKUP_OFFSITE_PREFIX',
    'BACKUP_OFFSITE_ACCESS_KEY_ID',
    'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
    'BACKUP_OFFSITE_PUBLIC_KEY',
    'BACKUP_OFFSITE_RETENTION_DAYS',
    'BACKUP_OFFSITE_ALLOW_HTTP',
    'CREDENTIAL_ENCRYPTION_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let s3: SlowS3;
  let runs: Row[];
  let configRow: Row;
  let prisma: ReturnType<typeof makePrisma>;
  let notice: { announceOffsite: jest.Mock };
  let svc: OffsiteService;
  let logged: string[];
  let key: OffsitePrivateKey;
  const archiveText =
    'PGDMP plaintext organization rows that must never be readable off-site\n'.repeat(50);

  function addRun(id: string, filename: string, startedAt: Date) {
    fs.writeFileSync(path.join(dir, filename), archiveText);
    runs.push({
      id,
      status: 'succeeded',
      filename,
      archiveDirectory: dir,
      startedAt,
      offsiteStatus: null,
      offsiteStartedAt: null,
      offsiteFinishedAt: null,
      offsiteHeartbeatAt: null,
    });
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    key = generateOffsiteKeyPair();
    Object.assign(process.env, {
      BACKUP_OFFSITE_ENABLED: 'true',
      BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
      BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
      BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BACKUP_OFFSITE_SECRET_ACCESS_KEY: SECRET,
      BACKUP_OFFSITE_PUBLIC_KEY: key.publicKey.text,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    for (const k of [
      'BACKUP_OFFSITE_RETENTION_DAYS',
      'BACKUP_OFFSITE_PREFIX',
      'BACKUP_OFFSITE_ALLOW_HTTP',
    ]) {
      delete process.env[k];
    }
    _resetKeyCacheForTests();

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-offsite-'));
    runs = [];
    addRun('run-1', NAME1, new Date(Date.now() - DAY));
    configRow = { ...emptyConfigRow(), offsiteInstallId: '0f1e2d3c-aaaa-4bbb-8ccc-000000000001' };
    s3 = new SlowS3();
    notice = { announceOffsite: jest.fn().mockResolvedValue(true) };
    const backup = {
      configRow: jest.fn(async () => configRow),
      getConfig: jest.fn(async () => ({ archiveDirectory: dir })),
      onRunSucceeded: jest.fn(),
    } as unknown as BackupService;
    prisma = makePrisma(runs, configRow);
    svc = new OffsiteService(prisma as never, backup, notice as never);
    svc.clientFactory = () => s3;
    svc.endpointCheck = async () => undefined;

    logged = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    s3.release();
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetKeyCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runUpload(id = 'run-1', objectBytes: number | null = 10) {
    const handle = await svc.startUpload(id, objectBytes);
    await handle?.done;
  }

  const PREFIX = 'gratisgis-0f1e2d3c/';

  it('uploads a copy only the private key opens, with a sidecar and a folder marker', async () => {
    await runUpload();
    const run = runs[0]!;
    expect(run.offsiteStatus).toBe('succeeded');
    expect(run.offsiteMode).toBe('archive');
    expect(run.offsiteKeyFingerprint).toBe(key.publicKey.fingerprintText);
    const objectKey = `${PREFIX}archives/${NAME1}.enc`;
    expect(run.offsiteKey).toBe(objectKey);
    expect(Number(run.offsiteBytes)).toBe(sealedSize(Buffer.byteLength(archiveText)));
    const stored = s3.objects.get(objectKey)!.body;
    expect(stored.includes(Buffer.from('PGDMP'))).toBe(false);
    const plain = await collect(unsealStream(Readable.from([stored]), key));
    expect(plain.toString()).toBe(archiveText);
    // Another key cannot open it.
    await expect(
      collect(unsealStream(Readable.from([stored]), generateOffsiteKeyPair())),
    ).rejects.toThrow(/different key/);
    const sidecar = JSON.parse(s3.objects.get(`${objectKey}.json`)!.body.toString()) as Record<
      string,
      unknown
    >;
    expect(sidecar).toMatchObject({
      format: 'GROF1',
      sealedSha256: run.offsiteSha256,
      keyFingerprint: key.publicKey.fingerprintText,
      installId: configRow.offsiteInstallId,
    });
    const marker = JSON.parse(
      s3.objects.get(`${PREFIX}gratisgis-install.json`)!.body.toString(),
    ) as {
      installId: string;
    };
    expect(marker.installId).toBe(configRow.offsiteInstallId);
    for (const o of s3.objects.values()) expect(o.body.includes(Buffer.from(SECRET))).toBe(false);
    expect(logged.join('\n')).toContain(key.publicKey.fingerprintText);
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
    expect(fs.existsSync(path.join(dir, NAME1))).toBe(true);
  });

  it('never logs or stores the secret, even when an error message echoes it', async () => {
    s3.failAll(`Odd error mentioning ${SECRET}`, 500);
    await runUpload();
    await svc.testConnection();
    const run = runs[0]!;
    expect(String(run.offsiteError)).not.toContain(SECRET);
    expect(String(run.offsiteError)).toContain('[redacted]');
    for (const line of logged) expect(line).not.toContain(SECRET);
  });

  it('never returns the secret; shows the public key with its fingerprint', async () => {
    delete process.env.BACKUP_OFFSITE_PUBLIC_KEY;
    await svc.updateConfig(
      {
        endpoint: 'https://s3.example.test',
        secretAccessKey: 'db-only-secret-9999',
        publicKey: key.publicKey.text,
      },
      null,
    );
    const view = await svc.getPublicConfig();
    const json = JSON.stringify(view);
    for (const s of [SECRET, 'db-only-secret-9999']) expect(json).not.toContain(s);
    expect(view.hasSecretAccessKey).toBe(true);
    expect(view.secretAccessKeySource).toBe('database');
    expect(view.publicKey).toBe(key.publicKey.text);
    expect(view.publicKeyFingerprint).toBe(key.publicKey.fingerprintText);
    expect(view.publicKeySource).toBe('database');
    expect(String(configRow.offsiteSecretEncrypted)).not.toContain('db-only-secret-9999');
    for (const line of logged) expect(line).not.toContain('db-only-secret-9999');
  });

  it('never accepts, stores, logs or returns a private key or passphrase', async () => {
    const keyFile = (await sealKeyFile(key, KEY_PASS, { logN: 14 })).toString('latin1');
    const priv = `ggsec1:${'A'.repeat(48)}`;
    await expect(svc.updateConfig({ passphrase: KEY_PASS } as never, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.updateConfig({ publicKey: priv }, null)).rejects.toThrow(/private key/);
    await expect(svc.updateConfig({ publicKey: keyFile.slice(0, 190) }, null)).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.checkKey(priv)).rejects.toThrow(/private key/);
    await expect(svc.checkKey(KEY_PASS)).rejects.toThrow(BadRequestException);
    const stored = JSON.stringify(configRow);
    const view = JSON.stringify(await svc.getPublicConfig());
    for (const text of [stored, view, logged.join('\n')]) {
      expect(text).not.toContain(KEY_PASS);
      expect(text).not.toContain(priv);
      expect(text).not.toContain('ggsec1:');
    }
    expect(Object.keys(configRow).some((k) => /passphrase|private/i.test(k))).toBe(false);
  });

  it('"check my key" matches the public key or its fingerprint, and nothing else', async () => {
    expect((await svc.checkKey(key.publicKey.text)).matches).toBe(true);
    expect((await svc.checkKey(key.publicKey.fingerprintText.toUpperCase())).matches).toBe(true);
    const other = generateOffsiteKeyPair().publicKey;
    const res = await svc.checkKey(other.text);
    expect(res).toEqual({
      matches: false,
      serverFingerprint: key.publicKey.fingerprintText,
      checkedFingerprint: other.fingerprintText,
    });
  });

  describe('the secret goes only with the endpoint it was entered for', () => {
    it('a saved secret: asks again when the endpoint or key id changes', async () => {
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
      await expect(svc.updateConfig({ accessKeyId: 'AK2' }, null)).rejects.toThrow(
        /secret access key again/,
      );
      await expect(
        svc.updateConfig(
          { endpoint: 'https://b.example.test', secretAccessKey: 'second-secret-value' },
          null,
        ),
      ).resolves.toBeDefined();
    });

    it('a secret from the environment: the page cannot point it elsewhere', async () => {
      await expect(
        svc.updateConfig({ endpoint: 'https://evil.example.test' }, null),
      ).rejects.toThrow(/secret access key again/);
    });

    it('clearing the saved secret is not typing one', async () => {
      await svc.updateConfig({ secretAccessKey: 'db-secret-value-1' }, null);
      await expect(
        svc.updateConfig({ endpoint: 'https://evil.example.test', secretAccessKey: '' }, null),
      ).rejects.toThrow(/secret access key again/);
    });

    it('a saved secret no longer opens once the endpoint is changed behind the page', async () => {
      delete process.env.BACKUP_OFFSITE_SECRET_ACCESS_KEY;
      await svc.updateConfig({ secretAccessKey: 'db-secret-value-2' }, null);
      expect((await svc.settings()).secretAccessKey).toBe('db-secret-value-2');
      configRow.offsiteEndpoint = 'https://elsewhere.example.test';
      expect((await svc.settings()).secretAccessKey).toBeNull();
    });
  });

  it('refuses to turn on with settings missing or refused', async () => {
    delete process.env.BACKUP_OFFSITE_PUBLIC_KEY;
    delete process.env.BACKUP_OFFSITE_ENABLED;
    await expect(svc.updateConfig({ enabled: true }, null)).rejects.toThrow(/public key/);
    process.env.BACKUP_OFFSITE_PUBLIC_KEY = 'ggpub1:broken';
    await expect(svc.updateConfig({ enabled: true }, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does nothing when off-site is off', async () => {
    process.env.BACKUP_OFFSITE_ENABLED = 'false';
    expect(await svc.startUpload('run-1', 10)).toBeUndefined();
    expect(runs[0]!.offsiteStatus).toBeNull();
    expect(s3.calls).toHaveLength(0);
  });

  it('does not upload with a refused environment value', async () => {
    process.env.BACKUP_OFFSITE_ENDPOINT = 'http://s3.example.test';
    await runUpload();
    expect(runs[0]!.offsiteStatus).toBe('failed');
    expect(String(runs[0]!.offsiteError)).toMatch(/endpoint/);
    expect(s3.calls).toHaveLength(0);
  });

  it('plain http only with the server flag, with a warning on every run', async () => {
    process.env.BACKUP_OFFSITE_ENDPOINT = 'http://minio.lan:9000';
    process.env.BACKUP_OFFSITE_ALLOW_HTTP = 'true';
    await runUpload();
    expect(runs[0]!.offsiteStatus).toBe('succeeded');
    expect(logged.filter((l) => /plain http/.test(l))).toHaveLength(1);
    addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
    await runUpload('run-2');
    expect(logged.filter((l) => /plain http/.test(l))).toHaveLength(2);
  });

  it('refuses an endpoint whose name points at this server', async () => {
    svc.endpointCheck = async () => {
      throw new Error('The endpoint name points at this server, so it is refused.');
    };
    await runUpload();
    expect(runs[0]!.offsiteStatus).toBe('failed');
    expect(s3.calls).toHaveLength(0);
  });

  it('one off-site upload at a time for the whole install', async () => {
    addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
    runs[0]!.offsiteStatus = 'running';
    runs[0]!.offsiteHeartbeatAt = new Date();
    expect(await svc.startUpload('run-2', 10)).toBeUndefined();
    expect(runs[1]!.offsiteStatus).toBeNull();
    await expect(svc.retry('run-2')).rejects.toThrow(/already running/);
    // A dead one is closed out and no longer blocks.
    runs[0]!.offsiteHeartbeatAt = new Date(Date.now() - 60 * 60 * 1000);
    await runUpload('run-2');
    expect(runs[0]!.offsiteStatus).toBe('failed');
    expect(runs[1]!.offsiteStatus).toBe('succeeded');
  });

  it('answers before the upload ends; the heartbeat keeps coming while it waits', async () => {
    svc.beatEveryMs = 20;
    s3.hold();
    const handle = await svc.startUpload('run-1', 10);
    expect(handle).toBeDefined();
    expect(runs[0]!.offsiteStatus).toBe('running');
    const first = runs[0]!.offsiteHeartbeatAt as Date;
    await new Promise((r) => setTimeout(r, 150));
    expect(runs[0]!.offsiteStatus).toBe('running');
    expect((runs[0]!.offsiteHeartbeatAt as Date).getTime()).toBeGreaterThan(first.getTime());
    s3.release();
    await handle!.done;
    expect(runs[0]!.offsiteStatus).toBe('succeeded');
  });

  describe('the run-succeeded hook', () => {
    function listener() {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((r) => {
        finish = r;
      });
      return { fn: jest.fn(async () => ({ done })), finish };
    }

    it('a manual run returns before the upload finishes', async () => {
      const l = listener();
      let returned = false;
      await dispatchRunSucceeded(
        [l.fn],
        { runId: 'r', objectBytes: 1 },
        'manual',
        () => undefined,
      ).then(() => {
        returned = true;
      });
      expect(returned).toBe(true);
      l.finish();
    });

    it('a scheduled run waits for the upload', async () => {
      const l = listener();
      let returned = false;
      const p = dispatchRunSucceeded(
        [l.fn],
        { runId: 'r', objectBytes: 1 },
        'scheduled',
        () => undefined,
      ).then(() => {
        returned = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(returned).toBe(false);
      l.finish();
      await p;
      expect(returned).toBe(true);
    });

    it('a listener that throws never fails the backup', async () => {
      const warn = jest.fn();
      await expect(
        dispatchRunSucceeded(
          [jest.fn(async () => Promise.reject(new Error('boom')))],
          { runId: 'r', objectBytes: 1 },
          'scheduled',
          warn,
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/boom/));
    });

    it('with the real service: a manual trigger answers while the upload is held', async () => {
      s3.hold();
      let handle: Awaited<ReturnType<typeof svc.startUpload>>;
      await dispatchRunSucceeded(
        [
          async (info) => {
            handle = await svc.startUpload(info.runId, info.objectBytes);
            return handle;
          },
        ],
        { runId: 'run-1', objectBytes: 10 },
        'manual',
        () => undefined,
      );
      expect(runs[0]!.offsiteStatus).toBe('running');
      s3.release();
      await handle!?.done;
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
    });
  });

  it('stops when the folder belongs to another portal, and deletes nothing', async () => {
    s3.objects.set(`${PREFIX}gratisgis-install.json`, {
      body: Buffer.from(JSON.stringify({ installId: 'ffffffff-other-install' })),
      lastModified: new Date(),
      etag: '"m"',
    });
    s3.objects.set(`${PREFIX}archives/backup-2020-01-01T00-00-00-000-99999999.tar.gz.enc`, {
      body: Buffer.from('x'),
      lastModified: new Date(0),
      etag: '"x"',
    });
    await runUpload();
    expect(runs[0]!.offsiteStatus).toBe('failed');
    expect(String(runs[0]!.offsiteError)).toMatch(/belongs to another GratisGIS portal/);
    expect(s3.calls).not.toContain('DeleteObjectCommand');
    expect((await svc.testConnection()).message).toMatch(/belongs to another/);
  });

  it('key rotation: new copies use the new key, old copies still open with the old one', async () => {
    await runUpload();
    const next = generateOffsiteKeyPair();
    process.env.BACKUP_OFFSITE_PUBLIC_KEY = next.publicKey.text;
    addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
    await runUpload('run-2');
    expect(runs[1]!.offsiteKeyFingerprint).toBe(next.publicKey.fingerprintText);
    const oldCopy = s3.objects.get(String(runs[0]!.offsiteKey))!.body;
    const newCopy = s3.objects.get(String(runs[1]!.offsiteKey))!.body;
    expect((await collect(unsealStream(Readable.from([oldCopy]), key))).toString()).toBe(
      archiveText,
    );
    expect((await collect(unsealStream(Readable.from([newCopy]), next))).toString()).toBe(
      archiveText,
    );
    await expect(collect(unsealStream(Readable.from([oldCopy]), next))).rejects.toThrow(
      /different key/,
    );
  });

  it('logs a key replacement with both fingerprints', async () => {
    delete process.env.BACKUP_OFFSITE_PUBLIC_KEY;
    await svc.updateConfig({ publicKey: key.publicKey.text }, null);
    const next = generateOffsiteKeyPair().publicKey;
    await svc.updateConfig({ publicKey: next.text }, null);
    expect(logged.join('\n')).toMatch(
      new RegExp(`${key.publicKey.fingerprintText} is now ${next.fingerprintText}`),
    );
  });

  it('retention removes old copies and keeps the newest good one', async () => {
    const now = Date.now();
    const put = (name: string, ageDays: number) => {
      s3.objects.set(`${PREFIX}archives/${name}`, {
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
    s3.objects.set(`${PREFIX}unrelated.txt`, {
      body: Buffer.from('x'),
      lastModified: new Date(0),
      etag: '"x"',
    });
    s3.objects.set('other-portal/archives/' + older, {
      body: Buffer.from('x'),
      lastModified: new Date(0),
      etag: '"x"',
    });
    const s = await svc.settings();
    const removed = await svc.enforceRetention(s, s3);
    expect(removed).toBe(3);
    expect([...s3.objects.keys()].sort()).toEqual(
      [
        `${PREFIX}archives/${newest}`,
        `${PREFIX}archives/${newest}.json`,
        `${PREFIX}unrelated.txt`,
        `other-portal/archives/${older}`,
      ].sort(),
    );
  });

  it('"Upload again" is refused for a copy retention would delete at once', async () => {
    addRun(
      'old',
      'backup-2025-01-01T00-00-00-000-cccccccc.tar.gz',
      new Date(Date.now() - 400 * DAY),
    );
    await expect(svc.retry('old')).rejects.toThrow(/retention window/);
  });

  it('raises the quiet-period notice once the alert window passes', async () => {
    runs[0]!.offsiteStatus = 'succeeded';
    runs[0]!.offsiteStartedAt = new Date(Date.now() - 10 * DAY);
    runs[0]!.offsiteFinishedAt = new Date(Date.now() - 5 * DAY);
    const k = await svc.checkStale();
    expect(k).toBe('stale:run-1');
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
    expect(s3.calls).toEqual([
      'GetObjectCommand',
      'PutObjectCommand',
      'ListObjectsV2Command',
      'DeleteObjectCommand',
    ]);
    expect(s3.objects.size).toBe(0);
  });

  it('connection test reports clock skew in plain words', async () => {
    s3.failAll('RequestTimeTooSkewed', 403);
    const res = await svc.testConnection();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/clock/);
  });

  it('gives every install its own id once', async () => {
    configRow.offsiteInstallId = null;
    const a = await svc.settings();
    const b = await svc.settings();
    expect(a.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.installId).toBe(a.installId);
    expect(a.prefix).toBe(`gratisgis-${a.installId!.replace(/-/g, '').slice(0, 8)}/`);
  });
});
