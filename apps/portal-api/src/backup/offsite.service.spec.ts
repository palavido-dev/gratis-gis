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
import { generateSigningKey, signManifest, type OffsiteSigningKey } from './offsite-sign.js';
import { MAX_SET_ASIDE_CHECKED } from './offsite-rules.js';
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
    'BACKUP_OFFSITE_MAX_UPLOAD_HOURS',
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
      'BACKUP_OFFSITE_MAX_UPLOAD_HOURS',
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

  async function runUpload(id = 'run-1') {
    const handle = await svc.startUpload(id);
    await handle?.done;
  }

  const PREFIX = 'gratisgis-0f1e2d3c/';

  it('uploads a copy only the private key opens, with a sidecar and a folder marker', async () => {
    await runUpload();
    const run = runs[0]!;
    expect(run.offsiteStatus).toBe('succeeded');
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

    it('an environment secret cannot be moved to a new endpoint in two saves', async () => {
      // Save 1: a new endpoint with a throwaway secret typed (allowed).
      await svc.updateConfig(
        { endpoint: 'https://evil.example.test', secretAccessKey: 'throwaway-value' },
        null,
      );
      // Save 2: clear the typed secret, hoping the environment's applies.
      await expect(svc.updateConfig({ secretAccessKey: '' }, null)).rejects.toThrow(
        /server environment also sets a secret/,
      );
      // Clearing together with the endpoint hands everything back to the environment.
      await svc.updateConfig({ secretAccessKey: '', endpoint: null }, null);
      const s = await svc.settings();
      expect(s.endpoint).toBe('https://s3.example.test');
      expect(s.secretAccessKey).toBe(SECRET);
    });

    it('a saved secret that no longer opens is not replaced by the environment secret', async () => {
      await svc.updateConfig(
        { endpoint: 'https://b.example.test', secretAccessKey: 'saved-for-b-value' },
        null,
      );
      // Changed behind the page: the saved secret no longer opens.
      configRow.offsiteEndpoint = 'https://c.example.test';
      const s = await svc.settings();
      expect(s.secretAccessKey).toBeNull();
      expect(s.secretAccessKey).not.toBe(SECRET);
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
    expect(await svc.startUpload('run-1')).toBeUndefined();
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

  it('the local endpoint flag logs a warning on every run', async () => {
    process.env.BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT = 'true';
    try {
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      const warned = () => logged.filter((l) => /ALLOW_LOCAL_ENDPOINT is on/.test(l));
      expect(warned()).toHaveLength(1);
      addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
      await runUpload('run-2');
      expect(warned()).toHaveLength(2);
    } finally {
      delete process.env.BACKUP_OFFSITE_ALLOW_LOCAL_ENDPOINT;
    }
  });

  it('no local endpoint warning when the flag is off', async () => {
    await runUpload();
    expect(logged.filter((l) => /ALLOW_LOCAL_ENDPOINT/.test(l))).toHaveLength(0);
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
    expect(await svc.startUpload('run-2')).toBeUndefined();
    // Marked failed, so the page shows it and offers "Upload again".
    expect(runs[1]!.offsiteStatus).toBe('failed');
    expect(String(runs[1]!.offsiteError)).toMatch(/^Skipped: another off-site upload was running/);
    expect(runs[0]!.offsiteStatus).toBe('running');
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
    const handle = await svc.startUpload('run-1');
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
      await dispatchRunSucceeded([l.fn], { runId: 'r' }, 'manual', () => undefined).then(() => {
        returned = true;
      });
      expect(returned).toBe(true);
      l.finish();
    });

    it('a scheduled run waits for the upload', async () => {
      const l = listener();
      let returned = false;
      const p = dispatchRunSucceeded([l.fn], { runId: 'r' }, 'scheduled', () => undefined).then(
        () => {
          returned = true;
        },
      );
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
          { runId: 'r' },
          'scheduled',
          warn,
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/boom/));
    });

    it('with the real service: a manual trigger answers while the upload is held', async () => {
      s3.hold();
      const got: { handle?: Awaited<ReturnType<typeof svc.startUpload>> } = {};
      await dispatchRunSucceeded(
        [
          async (info) => {
            got.handle = await svc.startUpload(info.runId);
            return got.handle;
          },
        ],
        { runId: 'run-1' },
        'manual',
        () => undefined,
      );
      expect(runs[0]!.offsiteStatus).toBe('running');
      s3.release();
      expect(got.handle).toBeDefined();
      await got.handle?.done;
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

  /** A sidecar as copies made before signing have: no signature. */
  const legacySidecar = (installId = configRow.offsiteInstallId) =>
    Buffer.from(JSON.stringify({ format: 'GROF1', kind: 'archive', installId }));

  /** A name's time stamp, `days` before now. */
  const stampAgo = (days: number) =>
    new Date(Date.now() - days * DAY).toISOString().replace(/[:.]/g, '-').replace('Z', '');

  /** A sidecar signed by `by` for a copy of `bytes` named `name` (with ".enc"). */
  const signedSidecarFor = (name: string, by: OffsiteSigningKey, bytes: number) =>
    Buffer.from(
      JSON.stringify({
        installId: configRow.offsiteInstallId,
        signature: signManifest(
          {
            kind: 'archive',
            format: 'GROF1',
            install: String(configRow.offsiteInstallId),
            prefix: PREFIX,
            name: `archives/${name}`,
            bytes: String(bytes),
            sha256: 'c'.repeat(64),
            key: key.publicKey.fingerprintText,
            created: new Date().toISOString(),
          },
          by,
        ),
      }),
    );

  it('retention removes old copies and keeps the newest good one', async () => {
    const now = Date.now();
    const put = (name: string, ageDays: number) => {
      s3.objects.set(`${PREFIX}archives/${name}`, {
        body: name.endsWith('.json') ? legacySidecar() : Buffer.from('x'),
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
    s3.objects.set(`${PREFIX}gratisgis-install.json`, {
      body: Buffer.from(JSON.stringify({ installId: configRow.offsiteInstallId })),
      lastModified: new Date(),
      etag: '"m"',
    });
    const s = await svc.settings();
    const removed = await svc.enforceRetention(s, s3);
    expect(removed).toBe(3);
    expect([...s3.objects.keys()].sort()).toEqual(
      [
        `${PREFIX}archives/${newest}`,
        `${PREFIX}archives/${newest}.json`,
        `${PREFIX}gratisgis-install.json`,
        `${PREFIX}unrelated.txt`,
        `other-portal/archives/${older}`,
      ].sort(),
    );
  });

  describe('retention in a folder another portal has taken over', () => {
    const OLD_COPY = `${PREFIX}archives/backup-2020-01-01T00-00-00-000-99999999.tar.gz.enc`;
    const setOwner = (installId: string) =>
      s3.objects.set(`${PREFIX}gratisgis-install.json`, {
        body: Buffer.from(JSON.stringify({ installId })),
        lastModified: new Date(),
        etag: '"m"',
      });
    beforeEach(() => {
      for (const k of [OLD_COPY, `${OLD_COPY}.json`]) {
        s3.objects.set(k, {
          body: k.endsWith('.json') ? legacySidecar() : Buffer.from('x'),
          lastModified: new Date(0),
          etag: '"x"',
        });
      }
    });

    it('removes nothing when the folder names another portal', async () => {
      setOwner('ffffffff-other-install');
      expect(await svc.enforceRetention(await svc.settings(), s3)).toBe(0);
      expect(s3.objects.has(OLD_COPY)).toBe(true);
      expect(logged.join('\n')).toMatch(/no longer owns the off-site folder/);
    });
  });

  it('a copy dated in the future is kept, reported, and does not stop retention', async () => {
    const put = (name: string, lastModified: Date) =>
      s3.objects.set(`${PREFIX}archives/${name}`, {
        body: name.endsWith('.json') ? legacySidecar() : Buffer.from('x'),
        lastModified,
        etag: '"x"',
      });
    const stamp = (at: Date) => at.toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const good = `backup-${stamp(new Date(Date.now() - 40 * DAY))}-11111111.tar.gz.enc`;
    const older = `backup-${stamp(new Date(Date.now() - 50 * DAY))}-22222222.tar.gz.enc`;
    const planted = 'backup-2099-01-01T00-00-00-000-44444444.tar.gz.enc';
    for (const n of [good, `${good}.json`]) put(n, new Date(Date.now() - 40 * DAY));
    for (const n of [older, `${older}.json`]) put(n, new Date(Date.now() - 50 * DAY));
    for (const n of [planted, `${planted}.json`]) put(n, new Date());
    s3.objects.set(`${PREFIX}gratisgis-install.json`, {
      body: Buffer.from(JSON.stringify({ installId: configRow.offsiteInstallId })),
      lastModified: new Date(),
      etag: '"m"',
    });
    const removed = await svc.enforceRetention(await svc.settings(), s3);
    // The good copy is still the newest one kept; the older one goes.
    expect(removed).toBe(2);
    expect(s3.objects.has(`${PREFIX}archives/${good}`)).toBe(true);
    expect(s3.objects.has(`${PREFIX}archives/${planted}`)).toBe(true);
    expect(s3.objects.has(`${PREFIX}archives/${older}`)).toBe(false);
    expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^set-aside:/), {
      kind: 'offsite_set_aside',
      count: 1,
      badSignature: 0,
      dated: 1,
      name: planted,
    });
    expect(logged.join('\n')).toMatch(/1 with a date that cannot be trusted/);
  });

  describe('retention and signatures', () => {
    const stamp = (d: number) =>
      new Date(Date.now() - d * DAY).toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const marker = () =>
      s3.objects.set(`${PREFIX}gratisgis-install.json`, {
        body: Buffer.from(JSON.stringify({ installId: configRow.offsiteInstallId })),
        lastModified: new Date(),
        etag: '"m"',
      });
    const putCopy = (name: string, ageDays: number, sidecar: Buffer) => {
      const at = new Date(Date.now() - ageDays * DAY);
      s3.objects.set(`${PREFIX}archives/${name}`, {
        body: Buffer.from('x'),
        lastModified: at,
        etag: '"x"',
      });
      s3.objects.set(`${PREFIX}archives/${name}.json`, {
        body: sidecar,
        lastModified: at,
        etag: '"x"',
      });
    };
    const signedSidecar = (name: string, by: OffsiteSigningKey, change = {}) =>
      Buffer.from(
        JSON.stringify({
          installId: configRow.offsiteInstallId,
          signature: signManifest(
            {
              kind: 'archive',
              format: 'GROF1',
              install: String(configRow.offsiteInstallId),
              prefix: PREFIX,
              name: `archives/${name}`,
              bytes: '1',
              sha256: 'c'.repeat(64),
              key: key.publicKey.fingerprintText,
              created: new Date().toISOString(),
              ...change,
            },
            by,
          ),
        }),
      );
    const has = (name: string) => s3.objects.has(`${PREFIX}archives/${name}`);

    it('a signed copy replaces older unsigned ones as the newest good copy', async () => {
      marker();
      const own = await svc.signingKey();
      const legacy = `backup-${stamp(40)}-11111111.tar.gz.enc`;
      const signed = `backup-${stamp(45)}-22222222.tar.gz.enc`;
      const old = `backup-${stamp(50)}-33333333.tar.gz.enc`;
      putCopy(legacy, 40, legacySidecar());
      putCopy(signed, 45, signedSidecar(signed, own));
      putCopy(old, 50, legacySidecar());
      await svc.enforceRetention(await svc.settings(), s3);
      expect(has(signed)).toBe(true);
      expect(has(legacy)).toBe(false);
      expect(has(old)).toBe(false);
    });

    it('copies signed by an earlier signing key of this portal still count', async () => {
      marker();
      const before = await svc.signingKey();
      await svc.replaceSigningKey('admin-user');
      const signed = `backup-${stamp(45)}-22222222.tar.gz.enc`;
      const legacy = `backup-${stamp(40)}-11111111.tar.gz.enc`;
      putCopy(signed, 45, signedSidecar(signed, before));
      putCopy(legacy, 40, legacySidecar());
      await svc.enforceRetention(await svc.settings(), s3);
      expect(has(signed)).toBe(true);
      expect(has(legacy)).toBe(false);
    });

    it('a badly signed copy is set aside: never the newest, never deleted, reported', async () => {
      marker();
      const own = await svc.signingKey();
      const good = `backup-${stamp(40)}-11111111.tar.gz.enc`;
      const forged = `backup-${stamp(2)}-44444444.tar.gz.enc`;
      const changed = `backup-${stamp(3)}-55555555.tar.gz.enc`;
      const older = `backup-${stamp(50)}-66666666.tar.gz.enc`;
      putCopy(good, 40, signedSidecar(good, own));
      putCopy(forged, 2, signedSidecar(forged, generateSigningKey()));
      putCopy(changed, 3, signedSidecar(changed, own, { bytes: '99' }));
      putCopy(older, 50, signedSidecar(older, own));
      await svc.enforceRetention(await svc.settings(), s3);
      expect(has(good)).toBe(true);
      expect(has(forged)).toBe(true);
      expect(has(changed)).toBe(true);
      expect(has(older)).toBe(false);
      // One summary notice for the pass, not one per copy.
      expect(notice.announceOffsite).toHaveBeenCalledTimes(1);
      expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^set-aside:/), {
        kind: 'offsite_set_aside',
        count: 2,
        badSignature: 2,
        dated: 0,
        name: [forged, changed].sort().join(', '),
      });
      expect(logged.join('\n')).toMatch(
        /2 not signed by this portal or not matching their signature/,
      );
    });

    it('reads at most a fixed number of badly signed copies per pass, and then deletes nothing older', async () => {
      marker();
      const own = await svc.signingKey();
      const older = `backup-${stamp(50)}-66666666.tar.gz.enc`;
      putCopy(older, 50, signedSidecar(older, own));
      const stranger = generateSigningKey();
      for (let i = 0; i < MAX_SET_ASIDE_CHECKED + 2; i += 1) {
        const n = `backup-${stamp(1 + i / 1000)}-${String(i).padStart(8, '0')}.tar.gz.enc`;
        putCopy(n, 1, signedSidecar(n, stranger));
      }
      s3.calls.length = 0;
      await svc.enforceRetention(await svc.settings(), s3);
      expect(has(older)).toBe(true);
      expect(s3.calls.filter((c) => c === 'DeleteObjectCommand')).toHaveLength(0);
      expect(s3.calls.filter((c) => c === 'GetObjectCommand').length).toBeLessThanOrEqual(
        MAX_SET_ASIDE_CHECKED + 2,
      );
      expect(notice.announceOffsite).toHaveBeenCalledTimes(1);
      expect(notice.announceOffsite.mock.calls[0]![1]).toMatchObject({
        kind: 'offsite_set_aside',
        count: MAX_SET_ASIDE_CHECKED,
        badSignature: MAX_SET_ASIDE_CHECKED,
      });
      expect(logged.join('\n')).toMatch(/older off-site copies were not checked this pass/);
    });

    it.each([
      ['cannot be read', null],
      ['is not JSON', Buffer.from('{not json')],
      ['is not an object', Buffer.from('[]')],
    ])(
      'a sidecar that %s stops the pass with nothing deleted, and is reported',
      async (_l, body) => {
        marker();
        const own = await svc.signingKey();
        const good = `backup-${stamp(40)}-11111111.tar.gz.enc`;
        const older = `backup-${stamp(50)}-66666666.tar.gz.enc`;
        putCopy(good, 40, signedSidecar(good, own));
        putCopy(older, 50, signedSidecar(older, own));
        if (body) {
          s3.objects.get(`${PREFIX}archives/${good}.json`)!.body = body;
        } else {
          const send = s3.send.bind(s3);
          jest.spyOn(s3, 'send').mockImplementation(async (c) => {
            const cmd = c as { constructor: { name: string }; input: Record<string, unknown> };
            if (
              cmd.constructor.name === 'GetObjectCommand' &&
              cmd.input.Key === `${PREFIX}archives/${good}.json`
            ) {
              throw Object.assign(new Error('fake read failure'), { name: 'InternalError' });
            }
            return send(c as never);
          });
        }
        expect(await svc.enforceRetention(await svc.settings(), s3)).toBe(0);
        expect(has(older)).toBe(true);
        expect(has(good)).toBe(true);
        expect(notice.announceOffsite).toHaveBeenCalledWith(
          expect.stringMatching(/^retention-stopped:\d{4}-\d{2}-\d{2}$/),
          { kind: 'offsite_retention_stopped', name: good },
        );
        expect(logged.join('\n')).toMatch(/Off-site retention stopped.*Nothing was deleted/);
      },
    );

    it('an unsigned copy from another install id never counts as the newest', async () => {
      marker();
      const own = await svc.signingKey();
      const stranger = `backup-${stamp(35)}-77777777.tar.gz.enc`;
      const signed = `backup-${stamp(45)}-22222222.tar.gz.enc`;
      putCopy(stranger, 35, legacySidecar('99999999-aaaa-4bbb-8ccc-000000000009'));
      putCopy(signed, 45, signedSidecar(signed, own));
      await svc.enforceRetention(await svc.settings(), s3);
      expect(has(signed)).toBe(true);
      expect(has(stranger)).toBe(false);
    });
  });

  describe('the signing key', () => {
    it('is made once, stored encrypted, and its private half never leaves the server', async () => {
      const cfg = await svc.getPublicConfig();
      const k = await svc.signingKey();
      expect(cfg.signing.verifyKey).toBe(k.verifyKey.text);
      expect(cfg.signing.fingerprint).toBe(k.verifyKey.fingerprintText);
      expect((await svc.signingKey()).verifyKey.text).toBe(k.verifyKey.text);
      expect(configRow.offsiteSigningKeyEncrypted).toBeTruthy();
      const seedForms = [
        k.seed.toString('base64'),
        k.seed.toString('hex'),
        k.seed.toString('base64url'),
      ];
      expect(String(configRow.offsiteSigningKeyEncrypted)).not.toContain(seedForms[0]);
      // A copy, a key change and the answers to the page.
      await runUpload();
      const replaced = await svc.replaceSigningKey('admin-user');
      const answers = JSON.stringify([
        cfg,
        await svc.getPublicConfig(),
        await svc.checkVerifyKey(k.verifyKey.text),
        { from: replaced.from, to: replaced.to },
      ]);
      const notices = JSON.stringify(notice.announceOffsite.mock.calls);
      const bucket = [...s3.objects.values()].map((o) => o.body.toString('latin1')).join('\n');
      const secrets = [k.seed, replaced.key.seed].flatMap((b) => [
        b.toString('base64'),
        b.toString('hex'),
        b.toString('base64url'),
      ]);
      for (const secret of secrets) {
        expect(answers).not.toContain(secret);
        expect(notices).not.toContain(secret);
        expect(logged.join('\n')).not.toContain(secret);
        expect(bucket).not.toContain(secret);
      }
      expect(bucket).not.toContain(String(configRow.offsiteSigningKeyEncrypted));
    });

    it('a new key keeps the old verify key trusted, records who, and tells the operator admins', async () => {
      const first = await svc.signingKey();
      const res = await svc.replaceSigningKey('admin-user');
      expect(res.from).toBe(first.verifyKey.fingerprintText);
      expect(res.to).not.toBe(res.from);
      expect(configRow.offsitePreviousVerifyKeys).toEqual([first.verifyKey.text]);
      expect(configRow.offsiteSigningKeyChangedBy).toBe('admin-user');
      expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^signing:/), {
        kind: 'offsite_signing_key_changed',
        from: res.from,
        to: res.to,
        automatic: false,
        oldKeyKept: true,
      });
      const info = await svc.signingInfo();
      expect(info.previousFingerprints).toEqual([first.verifyKey.fingerprintText]);
      expect(await svc.checkVerifyKey(first.verifyKey.text)).toMatchObject({
        matches: false,
        previous: true,
      });
      expect(await svc.checkVerifyKey(res.key.verifyKey.fingerprintText)).toMatchObject({
        matches: true,
      });
    });

    it('a stored key that no longer matches is replaced, its verify key is not trusted, and the admins are told', async () => {
      const first = await svc.signingKey();
      await svc.replaceSigningKey('admin-user');
      const kept = [...(configRow.offsitePreviousVerifyKeys as string[])];
      expect(kept).toEqual([first.verifyKey.text]);
      const planted = generateSigningKey().verifyKey;
      configRow.offsiteVerifyKey = planted.text;
      notice.announceOffsite.mockClear();
      // Outside an upload it is reported, never replaced.
      const before = configRow.offsiteSigningKeyEncrypted;
      await expect(svc.signingKey()).rejects.toThrow(/cannot be opened/);
      expect((await svc.signingInfo()).unopenable).toBe(true);
      expect(configRow.offsiteSigningKeyEncrypted).toBe(before);
      const next = await svc.signingKey({ replaceUnopenable: true });
      expect(next.verifyKey.text).not.toBe(planted.text);
      // The verify key that did not match is never carried over.
      expect(configRow.offsitePreviousVerifyKeys).toEqual(kept);
      expect((await svc.signingInfo()).previousFingerprints).not.toContain(planted.fingerprintText);
      expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^signing:/), {
        kind: 'offsite_signing_key_changed',
        from: planted.fingerprintText,
        to: next.verifyKey.fingerprintText,
        automatic: true,
        oldKeyKept: false,
      });
      expect(logged.join('\n')).toMatch(/replaced automatically.*is not kept/);
    });

    it('a stored key that cannot be opened keeps its verify key, so earlier copies still count and are retained as before', async () => {
      // Two copies signed by the first key: a recent one, and one past
      // the retention window.
      const recent = `backup-${stampAgo(2)}-aaaaaaa1.tar.gz`;
      addRun('run-a', recent, new Date(Date.now() - 2 * DAY));
      await runUpload('run-a');
      const first = configRow.offsiteVerifyKey as string;
      const own = await svc.signingKey();
      const recentKey = `${PREFIX}archives/${recent}.enc`;
      const oldName = `backup-${stampAgo(60)}-cccccccc.tar.gz.enc`;
      const oldKey = `${PREFIX}archives/${oldName}`;
      const at = new Date(Date.now() - 60 * DAY);
      s3.objects.set(oldKey, { body: Buffer.from('old copy'), lastModified: at, etag: '"o"' });
      s3.objects.set(`${oldKey}.json`, {
        body: signedSidecarFor(oldName, own, Buffer.byteLength('old copy')),
        lastModified: at,
        etag: '"o"',
      });

      // The server key changes: the stored signing key no longer opens.
      process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      _resetKeyCacheForTests();
      notice.announceOffsite.mockClear();
      addRun('run-b', `backup-${stampAgo(1)}-bbbbbbb1.tar.gz`, new Date(Date.now() - DAY));
      await runUpload('run-b');
      expect(runs.find((r) => r.id === 'run-b')!.offsiteStatus).toBe('succeeded');
      expect(configRow.offsiteVerifyKey).not.toBe(first);
      expect(configRow.offsitePreviousVerifyKeys).toEqual([first]);
      expect(notice.announceOffsite).toHaveBeenCalledWith(
        expect.stringMatching(/^signing:/),
        expect.objectContaining({ automatic: true, oldKeyKept: true }),
      );
      expect(logged.join('\n')).toMatch(/could not be opened; making a new one/);
      expect(logged.join('\n')).toMatch(/old verify key is kept/);
      // Earlier signed copies still count: nothing is set aside, the
      // recent one is kept, the one past the window is removed.
      expect(notice.announceOffsite).not.toHaveBeenCalledWith(
        expect.stringMatching(/^set-aside:/),
        expect.anything(),
      );
      expect(s3.objects.has(recentKey)).toBe(true);
      expect(s3.objects.has(oldKey)).toBe(false);
      expect(s3.objects.has(`${oldKey}.json`)).toBe(false);
    });

    it('a key that cannot be opened is only reported by the page and the checks; the next upload replaces it', async () => {
      await svc.getPublicConfig();
      const first = configRow.offsiteVerifyKey as string;
      const stored = configRow.offsiteSigningKeyEncrypted;
      expect(stored).toBeTruthy();
      expect((await svc.signingInfo()).unopenable).toBe(false);
      // A briefly wrong server key.
      const right = process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      _resetKeyCacheForTests();
      const cfg = await svc.getPublicConfig();
      expect(cfg.signing).toMatchObject({ unopenable: true, verifyKey: first });
      await svc.signingInfo();
      await svc.checkVerifyKey(first);
      await svc.updateConfig({ retentionDays: 31 }, 'admin-1');
      expect(configRow.offsiteSigningKeyEncrypted).toBe(stored);
      expect(configRow.offsiteVerifyKey).toBe(first);
      expect(notice.announceOffsite).not.toHaveBeenCalledWith(
        expect.stringMatching(/^signing:/),
        expect.anything(),
      );
      // The right key again: nothing changed.
      process.env.CREDENTIAL_ENCRYPTION_KEY = right;
      _resetKeyCacheForTests();
      expect((await svc.signingInfo()).unopenable).toBe(false);
      // Still wrong at upload time: the upload replaces it.
      process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      _resetKeyCacheForTests();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(configRow.offsiteVerifyKey).not.toBe(first);
      expect((await svc.signingInfo()).unopenable).toBe(false);
    });

    it('two key changes at once cannot lose a key: the second is refused', async () => {
      const first = await svc.signingKey();
      // Both requests read the same row before either writes.
      const snapshot = { ...configRow };
      const backup = (svc as unknown as { backup: { configRow: jest.Mock } }).backup;
      backup.configRow.mockImplementation(async () => ({ ...snapshot }));
      const results = await Promise.allSettled([
        svc.replaceSigningKey('admin-a'),
        svc.replaceSigningKey('admin-b'),
      ]);
      backup.configRow.mockImplementation(async () => configRow);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(failed.reason)).toMatch(/changed at the same time/);
      expect(configRow.offsitePreviousVerifyKeys).toEqual([first.verifyKey.text]);
    });

    it('refuses a private key pasted as a verify key', async () => {
      await expect(svc.checkVerifyKey('ggsec1:abc')).rejects.toThrow(/private key/);
    });

    it('an upload is refused without CREDENTIAL_ENCRYPTION_KEY, rather than sent unsigned', async () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      _resetKeyCacheForTests();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('failed');
      expect(String(runs[0]!.offsiteError)).toMatch(/needs CREDENTIAL_ENCRYPTION_KEY/);
      expect([...s3.objects.keys()].some((k) => k.endsWith('.enc'))).toBe(false);
    });
  });

  describe('an upload that stops getting answers', () => {
    it('is stopped by its time limit, marked failed, and frees the claim', async () => {
      svc.uploadLimitMs = () => 60;
      s3.hold();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('failed');
      expect(String(runs[0]!.offsiteError)).toMatch(/did not finish in the 1 hour\(s\) allowed/);
      expect(notice.announceOffsite).toHaveBeenCalledWith('deadline:none:60', {
        runId: 'run-1',
        kind: 'offsite_failed',
      });
      // The next upload can start at once.
      s3.release();
      svc.uploadLimitMs = () => 60_000;
      addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
      await runUpload('run-2');
      expect(runs[1]!.offsiteStatus).toBe('succeeded');
    });

    it('the time limit is the "longest upload" setting', async () => {
      expect(svc.uploadLimitMs(await svc.settings())).toBe(20 * 60 * 60 * 1000);
      process.env.BACKUP_OFFSITE_MAX_UPLOAD_HOURS = '30';
      expect(svc.uploadLimitMs(await svc.settings())).toBe(30 * 60 * 60 * 1000);
      await svc.updateConfig({ maxUploadHours: 6 }, 'admin-1');
      expect(svc.uploadLimitMs(await svc.settings())).toBe(6 * 60 * 60 * 1000);
      expect((await svc.getPublicConfig()).maxUploadHours).toBe(6);
      await expect(svc.updateConfig({ maxUploadHours: 73 }, 'admin-1')).rejects.toThrow(
        /from 1 to 72/,
      );
    });

    it('one notice per run of time-outs, again after a good copy or a changed limit', async () => {
      const keys = () => notice.announceOffsite.mock.calls.map((c) => c[0] as string);
      svc.uploadLimitMs = () => 60;
      s3.hold();
      await runUpload();
      addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
      await runUpload('run-2');
      // The same key twice: the notice table sends it once.
      expect(keys()).toEqual(['deadline:none:60', 'deadline:none:60']);
      // A changed limit is a new key.
      svc.uploadLimitMs = () => 90;
      addRun('run-3', 'backup-2026-11-24T04-00-00-000-cccccccc.tar.gz', new Date());
      await runUpload('run-3');
      expect(keys().at(-1)).toBe('deadline:none:90');
      // After a good copy, a new key.
      s3.release();
      svc.uploadLimitMs = () => 60_000;
      await runUpload('run-2');
      expect(runs[1]!.offsiteStatus).toBe('succeeded');
      svc.uploadLimitMs = () => 60;
      s3.hold();
      addRun('run-4', 'backup-2026-11-24T05-00-00-000-dddddddd.tar.gz', new Date());
      await runUpload('run-4');
      expect(keys().at(-1)).toBe('deadline:run-2:60');
    });
  });

  describe('a changed public key', () => {
    beforeEach(() => {
      delete process.env.BACKUP_OFFSITE_PUBLIC_KEY;
    });

    it('is recorded with who and when, and every operator admin is told', async () => {
      const first = await svc.updateConfig({ publicKey: key.publicKey.text }, 'admin-1');
      // Setting the first key is recorded but is not a replacement.
      expect(first.savedKeyChange).toEqual({ from: null, to: key.publicKey.fingerprintText });
      expect(notice.announceOffsite).not.toHaveBeenCalled();
      const next = generateOffsiteKeyPair().publicKey;
      const res = await svc.updateConfig({ publicKey: next.text }, 'admin-2');
      expect(res.savedKeyChange).toEqual({
        from: key.publicKey.fingerprintText,
        to: next.fingerprintText,
      });
      expect(configRow.offsiteKeyChangedBy).toBe('admin-2');
      expect(configRow.offsitePreviousFingerprint).toBe(key.publicKey.fingerprintText);
      expect(res.keyChange).toMatchObject({ previousFingerprint: key.publicKey.fingerprintText });
      expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^key:/), {
        kind: 'offsite_key_changed',
        from: key.publicKey.fingerprintText,
        to: next.fingerprintText,
      });
      // Saving other settings is not a key change.
      notice.announceOffsite.mockClear();
      const again = await svc.updateConfig({ retentionDays: 9 }, 'admin-2');
      expect(again.savedKeyChange).toBeNull();
      expect(notice.announceOffsite).not.toHaveBeenCalled();
    });

    it('removing the key is announced too', async () => {
      await svc.updateConfig({ publicKey: key.publicKey.text, enabled: false }, null);
      await svc.updateConfig({ publicKey: null, enabled: false }, null);
      expect(notice.announceOffsite).toHaveBeenCalledWith(expect.stringMatching(/^key:none:/), {
        kind: 'offsite_key_changed',
        from: key.publicKey.fingerprintText,
        to: null,
      });
    });
  });

  describe('taking over a folder after a restore', () => {
    const OLD = 'aaaaaaaa-1111-4222-8333-444444444444';
    beforeEach(() => {
      s3.objects.set(`${PREFIX}gratisgis-install.json`, {
        body: Buffer.from(JSON.stringify({ installId: OLD })),
        lastModified: new Date(),
        etag: '"m"',
      });
    });

    it('needs the start of the old install id typed, then claims the folder', async () => {
      await expect(svc.takeOverFolder('wrong')).rejects.toThrow(/Type aaaaaaaa/);
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('failed');
      expect(String(runs[0]!.offsiteError)).toMatch(/Take over this folder/);
      expect(await svc.takeOverFolder('AAAAAAAA')).toEqual({ previousOwner: 'aaaaaaaa' });
      const marker = JSON.parse(
        s3.objects.get(`${PREFIX}gratisgis-install.json`)!.body.toString(),
      ) as { installId: string; takenOverFrom: string };
      expect(marker).toMatchObject({ installId: configRow.offsiteInstallId, takenOverFrom: OLD });
      addRun('run-2', 'backup-2026-11-24T03-00-00-000-bbbbbbbb.tar.gz', new Date());
      await runUpload('run-2');
      expect(runs[1]!.offsiteStatus).toBe('succeeded');
      await expect(svc.takeOverFolder('aaaaaaaa')).rejects.toThrow(/already owns/);
    });

    it('refuses while an upload is running', async () => {
      runs[0]!.offsiteStatus = 'running';
      runs[0]!.offsiteHeartbeatAt = new Date();
      await expect(svc.takeOverFolder('aaaaaaaa')).rejects.toThrow(/upload is running/);
    });
  });

  it('"Upload again" is refused for a copy retention would delete at once', async () => {
    addRun(
      'old',
      'backup-2025-01-01T00-00-00-000-cccccccc.tar.gz',
      new Date(Date.now() - 400 * DAY),
    );
    await expect(svc.retry('old')).rejects.toThrow(/retention window/);
  });

  describe('uploading a backup again', () => {
    const base = `${PREFIX}archives/${NAME1}.enc`;
    const second = `${PREFIX}archives/${NAME1.replace('.tar.gz', '-r2.tar.gz')}.enc`;
    /** Object keys of the commands sent from now on. */
    const watch = () => {
      const sent: Array<[string, string]> = [];
      const send = s3.send.bind(s3);
      jest.spyOn(s3, 'send').mockImplementation(async (c) => {
        const cmd = c as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push([cmd.constructor.name, String(cmd.input.Key ?? '')]);
        return send(c as never);
      });
      return sent;
    };

    it('finds a complete signed copy from an earlier attempt and uploads nothing', async () => {
      await runUpload();
      const first = { ...runs[0]! };
      // The run was marked failed after its copy was complete.
      runs[0]!.offsiteStatus = 'failed';
      const sent = watch();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteKey).toBe(base);
      expect(runs[0]!.offsiteSha256).toBe(first.offsiteSha256);
      expect(runs[0]!.offsiteBytes).toBe(first.offsiteBytes);
      // Size from HEAD; the copy itself is never downloaded or written.
      expect(sent).toContainEqual(['HeadObjectCommand', base]);
      expect(sent.filter(([, k]) => k === base).map(([c]) => c)).toEqual(['HeadObjectCommand']);
      expect(sent.some(([c]) => c === 'CreateMultipartUploadCommand')).toBe(false);
      expect(s3.objects.has(second)).toBe(false);
      expect(logged.join('\n')).toMatch(/already complete and signed in the bucket/);
    });

    it('a complete earlier copy made for another public key is kept, and the backup goes up under the current key', async () => {
      await runUpload();
      const old = { ...runs[0]! };
      runs[0]!.offsiteStatus = 'failed';
      const next = generateOffsiteKeyPair();
      process.env.BACKUP_OFFSITE_PUBLIC_KEY = next.publicKey.text;
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteKey).toBe(second);
      expect(runs[0]!.offsiteKeyFingerprint).toBe(next.publicKey.fingerprintText);
      // The new copy opens with the new key; the old one is untouched.
      const plain = await collect(
        unsealStream(Readable.from([s3.objects.get(second)!.body]), next),
      );
      expect(plain.toString()).toBe(archiveText);
      expect(s3.objects.has(base)).toBe(true);
      expect(s3.objects.has(`${base}.json`)).toBe(true);
      expect(old.offsiteKeyFingerprint).toBe(key.publicKey.fingerprintText);
    });

    it('an unfinished earlier attempt: uploads under a new name, then removes the leftover', async () => {
      await runUpload();
      // The earlier attempt stopped before its sidecar was written.
      s3.objects.delete(`${base}.json`);
      runs[0]!.offsiteStatus = 'failed';
      const sent = watch();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteKey).toBe(second);
      expect(s3.objects.has(`${second}.json`)).toBe(true);
      expect(s3.objects.has(base)).toBe(false);
      // Removed only after the new copy and its sidecar were written.
      const putSidecar = sent.findIndex(
        ([c, k]) => c === 'PutObjectCommand' && k === `${second}.json`,
      );
      const removeOld = sent.findIndex(([c, k]) => c === 'DeleteObjectCommand' && k === base);
      expect(putSidecar).toBeGreaterThanOrEqual(0);
      expect(removeOld).toBeGreaterThan(putSidecar);
      // Nothing was written under the earlier name.
      expect(
        sent.some(
          ([c, k]) => c !== 'DeleteObjectCommand' && c !== 'HeadObjectCommand' && k === base,
        ),
      ).toBe(false);
      const plain = await collect(unsealStream(Readable.from([s3.objects.get(second)!.body]), key));
      expect(plain.toString()).toBe(archiveText);
    });

    it('a complete earlier copy that does not verify is kept as it is, and the backup goes up under a new name', async () => {
      await runUpload();
      const side = JSON.parse(s3.objects.get(`${base}.json`)!.body.toString()) as Record<
        string,
        unknown
      >;
      side.signature = signManifest(
        {
          kind: 'archive',
          format: 'GROF1',
          install: String(configRow.offsiteInstallId),
          prefix: PREFIX,
          name: `archives/${NAME1}.enc`,
          bytes: String(s3.objects.get(base)!.body.length),
          sha256: 'c'.repeat(64),
          key: key.publicKey.fingerprintText,
          created: new Date().toISOString(),
        },
        generateSigningKey(),
      );
      const planted = Buffer.from(JSON.stringify(side));
      s3.objects.get(`${base}.json`)!.body = planted;
      const before = Buffer.from(s3.objects.get(base)!.body);
      runs[0]!.offsiteStatus = 'failed';
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteKey).toBe(second);
      expect(s3.objects.get(base)!.body.equals(before)).toBe(true);
      expect(s3.objects.get(`${base}.json`)!.body.equals(planted)).toBe(true);
    });

    it('a signed copy whose stored size differs from the signed size is not used', async () => {
      await runUpload();
      runs[0]!.offsiteStatus = 'failed';
      s3.lieAboutSize = true;
      const send = s3.send.bind(s3);
      // Only the first HEAD (of the earlier copy) reports a wrong size.
      jest.spyOn(s3, 'send').mockImplementation(async (c) => {
        const r = await send(c as never);
        if ((c as { constructor: { name: string } }).constructor.name === 'HeadObjectCommand') {
          s3.lieAboutSize = false;
        }
        return r;
      });
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteKey).toBe(second);
      expect(s3.objects.has(base)).toBe(true);
    });
  });

  describe('a backup too large to upload in the time allowed', () => {
    const MiB = 1024 ** 2;
    const GiB = 1024 ** 3;
    /** An earlier upload that left a speed sample of `bytes` in `seconds`. */
    function pastUpload(id: string, bytes: number, seconds: number, hoursAgo: number) {
      const finished = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      runs.push({
        id,
        status: 'succeeded',
        filename: `${id}.tar.gz`,
        startedAt: new Date(finished.getTime() - seconds * 1000),
        offsiteStatus: 'succeeded',
        offsiteBytes: BigInt(bytes),
        offsiteStartedAt: new Date(finished.getTime() - seconds * 1000),
        offsiteFinishedAt: finished,
        offsiteSampleBytes: BigInt(bytes),
        offsiteSampleMs: seconds * 1000,
      });
    }

    it('is refused up front when the estimate at the measured speed cannot fit; the local backup stands', async () => {
      pastUpload('p1', 1000 * MiB, 1000, 1); // 1 MiB/s
      runs[0]!.sizeBytes = BigInt(Buffer.byteLength(archiveText));
      // At 1 MiB/s this backup takes about 4 ms; allow 1 ms.
      svc.uploadLimitMs = () => 1;
      await runUpload();
      const run = runs[0]!;
      expect(run.status).toBe('succeeded');
      expect(run.offsiteStatus).toBe('failed');
      expect(String(run.offsiteError)).toMatch(
        /At the measured speed of recent off-site uploads \(1\.00 MB\/s\).*so no off-site copy was made\. The local backup is complete\./,
      );
      expect(runs[0]!.offsiteVerifyFingerprint ?? null).toBeNull();
      expect(notice.announceOffsite).toHaveBeenCalledWith('too-large:p1:1', {
        runId: 'run-1',
        kind: 'offsite_failed',
      });
      expect([...s3.objects.keys()].some((k) => k.endsWith('.enc'))).toBe(false);
      const status = await svc.statusSummary();
      expect(status.lastArchive).toMatchObject({
        runId: 'run-1',
        bytes: String(Buffer.byteLength(archiveText)),
        tooLarge: true,
      });
      expect(status).toMatchObject({ maxUploadMs: 1, bytesPerSecond: MiB });
    });

    it('with no measured speed a large backup is attempted and stopped by the deadline', async () => {
      runs[0]!.sizeBytes = BigInt(30 * GiB);
      const status = await svc.statusSummary();
      expect(status).toMatchObject({
        bytesPerSecond: null,
        maxArchiveBytes: null,
        maxUploadMs: 20 * 60 * 60 * 1000,
      });
      expect(status.lastArchive).toMatchObject({ estimateMs: null, tooLarge: false });
      svc.uploadLimitMs = () => 60;
      s3.hold();
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('failed');
      expect(String(runs[0]!.offsiteError)).toMatch(/did not finish in the/);
      // It was started: signed for, then stopped by the deadline.
      expect(runs[0]!.offsiteVerifyFingerprint).toBeTruthy();
      expect(notice.announceOffsite).toHaveBeenCalledWith('deadline:none:60', {
        runId: 'run-1',
        kind: 'offsite_failed',
      });
      // Nothing was confirmed, so there is still no sample.
      expect(runs[0]!.offsiteSampleBytes ?? null).toBeNull();
      expect(await svc.uploadSpeed()).toBeNull();
    });

    it('plans with the slowest of the last three samples', async () => {
      runs[0]!.sizeBytes = BigInt(30 * GiB);
      pastUpload('p1', 1000 * MiB, 100, 1); // 10 MiB/s
      pastUpload('p2', 1000 * MiB, 500, 2); // 2 MiB/s, the slowest of the three
      pastUpload('p3', 1000 * MiB, 200, 3); // 5 MiB/s
      pastUpload('p4', 1000 * MiB, 10_000, 4); // older than the last three
      const status = await svc.statusSummary();
      expect(status.bytesPerSecond).toBe(2 * MiB);
      // 30 GB at 2 MiB/s is about 4.3 hours.
      expect(status.lastArchive!.tooLarge).toBe(false);
      expect(status.lastArchive!.estimateMs).toBe(30 * 512 * 1000);
      expect(Number(status.maxArchiveBytes) / GiB).toBeCloseTo(140.6, 1);
    });

    it('a backup that fits the estimate is tried, with the hard limit as its deadline', async () => {
      pastUpload('p1', 1000 * MiB, 100, 1);
      svc.uploadLimitMs = () => 60;
      s3.hold();
      await runUpload();
      expect(String(runs[0]!.offsiteError)).toMatch(/did not finish in the/);
      expect(runs[0]!.offsiteVerifyFingerprint).toBeTruthy();
    });

    it('a deadline failure leaves a speed sample and the next run is refused up front with that estimate', async () => {
      // Two parts of 16 MiB and the rest; the second part never answers.
      const big = 'backup-2026-11-24T05-00-00-000-dddddddd.tar.gz';
      fs.writeFileSync(path.join(dir, big), randomBytes(20 * MiB));
      runs.push({
        id: 'run-big',
        status: 'succeeded',
        filename: big,
        archiveDirectory: dir,
        startedAt: new Date(),
        sizeBytes: BigInt(20 * MiB),
        offsiteStatus: null,
      });
      let parts = 0;
      let gate: () => void = () => undefined;
      const held = new Promise<void>((r) => (gate = r));
      const send = s3.send.bind(s3);
      jest.spyOn(s3, 'send').mockImplementation(async (c) => {
        const cmd = c as { constructor: { name: string } };
        if (cmd.constructor.name === 'UploadPartCommand' && ++parts === 2) await held;
        return send(c as never);
      });
      // A part of 16 MiB counts as a sample here.
      svc.minSampleBytes = MiB;
      // Each reading of the clock is one minute later.
      let t = 0;
      svc.clock = () => (t += 60_000);
      svc.uploadLimitMs = () => 3000;
      await runUpload('run-big');
      gate();
      const run = runs.find((r) => r.id === 'run-big')!;
      expect(String(run.offsiteError)).toMatch(/did not finish in the/);
      // 16 MiB confirmed, over the two minutes spent sending.
      expect(run.offsiteSampleBytes).toBe(BigInt(16 * MiB));
      expect(run.offsiteSampleMs).toBe(120_000);
      const speed = await svc.uploadSpeed();
      expect(speed).toBeCloseTo((16 * MiB) / 120, 0);
      // The next try is refused at once, with that speed in the message.
      notice.announceOffsite.mockClear();
      await runUpload('run-big');
      expect(String(run.offsiteError)).toMatch(
        /At the measured speed of recent off-site uploads \(0\.13 MB\/s\).*about 1 hours/,
      );
      expect(notice.announceOffsite).toHaveBeenCalledWith('too-large:none:3000', {
        runId: 'run-big',
        kind: 'offsite_failed',
      });
      // A refused run sends nothing and keeps the figure it had.
      expect(run.offsiteSampleBytes).toBe(BigInt(16 * MiB));
      expect(run.offsiteStatus).toBe('failed');
    });

    it('a reused copy is not a sample', async () => {
      svc.minSampleBytes = 1;
      await runUpload();
      expect(Number(runs[0]!.offsiteSampleBytes)).toBe(Number(runs[0]!.offsiteBytes));
      expect(await svc.uploadSpeed()).not.toBeNull();
      // Marked failed after its copy was complete: the next try finds
      // the copy in the bucket and sends nothing.
      runs[0]!.offsiteStatus = 'failed';
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(logged.join('\n')).toMatch(/already complete and signed in the bucket/);
      expect(runs[0]!.offsiteSampleBytes ?? null).toBeNull();
      expect(await svc.uploadSpeed()).toBeNull();
    });

    it('a small, quick upload is not a sample', async () => {
      await runUpload();
      expect(runs[0]!.offsiteStatus).toBe('succeeded');
      expect(runs[0]!.offsiteSampleBytes ?? null).toBeNull();
    });
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
