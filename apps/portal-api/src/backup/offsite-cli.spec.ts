// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';

import { _resetKeyCacheForTests } from '../items/credential-cipher.js';
import { FakeS3 } from '../testing/fake-s3.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import type { BackupService } from './backup.service.js';
import { runCli, type CliIo } from './offsite-cli.js';
import { normalizePrefix, validateOffsitePatch } from './offsite-config.js';
import { endpointPolicy } from './offsite-endpoint.js';
import { generateOffsiteKeyPair, sealKeyFile, type OffsitePrivateKey } from './offsite-crypto.js';
import {
  generateSigningKey,
  signManifest,
  type ArchiveManifest,
  type OffsiteSigningKey,
} from './offsite-sign.js';
import { OffsiteService } from './offsite.service.js';

const PASS = 'cli test passphrase 98765';
const NAME = 'backup-2026-11-24T02-00-00-000-cccccccc.tar.gz';
const INSTALL = 'cccc1111-aaaa-4bbb-8ccc-000000000001';
const PREFIX = 'gratisgis-cccc1111/';

describe('offsite-cli', () => {
  const ENV: Record<string, string> = {
    BACKUP_OFFSITE_ENABLED: 'true',
    BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
    BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
    BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'cli-secret-value-1',
  };
  let dir: string;
  let remote: FakeS3;
  let local: FakeS3;
  let out: string[];
  let errs: string[];
  let stdin: string;
  let original: Buffer;
  let key: OffsitePrivateKey;
  let keyFile: string;
  /** The portal's own signing key, as the service made it. */
  let signer: OffsiteSigningKey;
  const withKey = (...args: string[]) => [...args, '--key-file', keyFile, '--passphrase-stdin'];
  const confirmed = (...args: string[]) => withKey(...args, '--confirm-copy', NAME);

  const io = (): CliIo => ({
    out: (l) => out.push(l),
    err: (l) => errs.push(l),
    stdin: async () => stdin,
    env: (n) => ENV[n],
    readFile: async (p) => fs.readFileSync(p),
    offsite: () => remote,
    local: () => ({ s3: local, bucket: 'gratisgis' }),
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-cli-'));
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(src, 'postgres'), { recursive: true });
    fs.mkdirSync(path.join(src, 'minio', 'items', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(src, 'manifest.json'),
      JSON.stringify({
        version: 1,
        databases: ['gratisgis'],
        minio: { objectCount: 2, totalBytes: 9 },
        portalVersion: '1.8.0',
      }),
    );
    fs.writeFileSync(path.join(src, 'postgres', 'gratisgis.dump'), randomBytes(3000));
    fs.writeFileSync(path.join(src, 'minio', 'items', 'a', 'photo.jpg'), 'JPEG');
    fs.writeFileSync(path.join(src, 'minio', 'top.txt'), 'hello');
    fs.writeFileSync(
      path.join(src, 'minio-meta.json'),
      JSON.stringify({
        version: 1,
        contentTypes: { 'items/a/photo.jpg': 'image/jpeg' },
        skipped: [],
      }),
    );
    fs.mkdirSync(path.join(dir, 'local'));
    execFileSync('tar', [
      '-czf',
      path.join(dir, 'local', NAME),
      '-C',
      src,
      'manifest.json',
      'postgres',
      'minio',
      'minio-meta.json',
    ]);
    original = fs.readFileSync(path.join(dir, 'local', NAME));

    remote = new FakeS3();
    local = new FakeS3();
    out = [];
    errs = [];
    stdin = `${PASS}\n`;
    key = generateOffsiteKeyPair();
    keyFile = path.join(dir, 'offsite.ggkey');
    fs.writeFileSync(keyFile, await sealKeyFile(key, PASS, { logN: 14 }));

    // Make a real off-site copy with the service.
    const saved = { ...process.env };
    Object.assign(process.env, ENV, {
      BACKUP_OFFSITE_PUBLIC_KEY: key.publicKey.text,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    _resetKeyCacheForTests();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const runs: Row[] = [
      {
        id: 'cccccccc-0000-4000-8000-000000000001',
        status: 'succeeded',
        filename: NAME,
        archiveDirectory: path.join(dir, 'local'),
        startedAt: new Date('2026-11-24T02:00:00Z'),
        offsiteStatus: null,
      },
    ];
    const cfg = { ...emptyConfigRow(), offsiteInstallId: INSTALL };
    const svc = new OffsiteService(
      makePrisma(runs, cfg) as never,
      {
        configRow: async () => cfg,
        onRunSucceeded: jest.fn(),
      } as unknown as BackupService,
    );
    svc.clientFactory = () => remote;
    svc.endpointCheck = async () => undefined;
    const handle = await svc.startUpload(String(runs[0]!.id));
    await handle?.done;
    signer = await svc.signingKey();
    process.env = saved;
    _resetKeyCacheForTests();
    expect(runs[0]!.offsiteStatus).toBe('succeeded');
    // The admin added the portal's verify key to the key file.
    fs.writeFileSync(
      keyFile,
      await sealKeyFile(key, PASS, {
        logN: 14,
        verifyKeys: [String((cfg as Row).offsiteVerifyKey)],
      }),
    );
  });

  const sideKey = (name = NAME) => `${PREFIX}archives/${name}.enc.json`;
  const sidecar = (name = NAME) =>
    JSON.parse(remote.objects.get(sideKey(name))!.body.toString()) as Record<string, unknown>;
  const setSidecar = (name: string, j: unknown) => {
    remote.objects.set(sideKey(name), {
      ...remote.objects.get(sideKey(NAME))!,
      body: Buffer.from(JSON.stringify(j)),
    });
  };
  const manifestOf = (j: Record<string, unknown>) =>
    (j.signature as { manifest: string }).manifest
      .split('\n')
      .slice(1, -1)
      .reduce(
        (o, l) => {
          const i = l.indexOf('=');
          o[l.slice(0, i)] = l.slice(i + 1);
          return o;
        },
        {} as Record<string, string>,
      ) as unknown as ArchiveManifest;
  /** A second, properly signed copy of the same bytes under another name. */
  const plantSigned = (name: string, by: OffsiteSigningKey = signer, change = {}) => {
    const src = remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!;
    remote.objects.set(`${PREFIX}archives/${name}.enc`, { ...src, lastModified: new Date() });
    const side = sidecar();
    const m = { ...manifestOf(side), name: `archives/${name}.enc`, ...change };
    side.signature = signManifest(m, by);
    setSidecar(name, side);
  };

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the portal folder when no prefix is set, and lists the newest complete copy', async () => {
    expect(await runCli(['list'], io())).toBe(0);
    expect(out).toContain(`prefix=${PREFIX}`);
    expect(out).toContain(`latest=${NAME}`);
    // list has no key file: a named verify key is shown as a claim only.
    expect(errs.join('\n')).toContain(
      `claims verify key ${signer.verifyKey.fingerprintText} (not checked by list)`,
    );
  });

  it('asks for a prefix when the bucket holds several portal folders', async () => {
    remote.objects.set('gratisgis-other/gratisgis-install.json', {
      body: Buffer.from('{"installId":"x"}'),
      lastModified: new Date(),
      etag: '"m"',
    });
    expect(await runCli(['list'], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/several portal folders.*BACKUP_OFFSITE_PREFIX/);
    ENV.BACKUP_OFFSITE_PREFIX = PREFIX;
    try {
      out.length = 0;
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain(`latest=${NAME}`);
    } finally {
      delete ENV.BACKUP_OFFSITE_PREFIX;
    }
  });

  it('check-key opens the key file and prints its fingerprint and trusted verify keys', async () => {
    stdin = `${PASS}\r\n`;
    expect(await runCli(['check-key', '--key-file', keyFile, '--passphrase-stdin'], io())).toBe(0);
    expect(out).toEqual([
      `fingerprint=${key.publicKey.fingerprintText}`,
      'verifyKeys=1',
      `verifyKey=${signer.verifyKey.fingerprintText}`,
    ]);
  });

  it('takes the key file and passphrase together on standard input', async () => {
    stdin = `${fs.readFileSync(keyFile).toString('base64')}\n${PASS}\r\n`;
    expect(await runCli(['check-key', '--key-stdin'], io())).toBe(0);
    expect(out[0]).toBe(`fingerprint=${key.publicKey.fingerprintText}`);
    out.length = 0;
    stdin = `${fs.readFileSync(keyFile).toString('base64')}\nthe wrong passphrase entirely`;
    expect(await runCli(['check-key', '--key-stdin'], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/did not open/);
    stdin = `not base64 at all!\n${PASS}`;
    expect(await runCli(['check-key', '--key-stdin'], io())).toBe(1);
  });

  it('fetches, verifies and decrypts the archive byte for byte', async () => {
    const outDir = path.join(dir, 'restore');
    // A partial file from an interrupted run does not get in the way.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${NAME}.partial`), 'left over');
    fs.writeFileSync(path.join(outDir, `${NAME}.enc.partial`), 'left over');
    expect(await runCli(['fetch', ...confirmed('--out', outDir)], io())).toBe(0);
    expect(out.slice(-4)).toEqual([
      `archive=${path.join(outDir, NAME)}`,
      'database=gratisgis',
      'objects=2',
      'portalVersion=1.8.0',
    ]);
    expect(fs.readFileSync(path.join(outDir, NAME)).equals(original)).toBe(true);
    expect(fs.statSync(path.join(outDir, NAME)).mode & 0o777).toBe(0o600);
  });

  it('refuses a changed byte of the copy before decrypting, and leaves nothing behind', async () => {
    const obj = remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!;
    const body = Buffer.from(obj.body);
    body[200]! ^= 1;
    obj.body = body;
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...confirmed('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/does not match the checksum in its signed record/);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('ignores the unsigned checksum fields of a signed sidecar', async () => {
    const side = sidecar();
    side.sealedSha256 = '0'.repeat(64);
    side.sealedBytes = 1;
    setSidecar(NAME, side);
    expect(await runCli(['fetch', ...confirmed('--out', path.join(dir, 'restore'))], io())).toBe(0);
  });

  it('describe says the copy is verified and which verify key signed it', async () => {
    expect(await runCli(['describe', ...withKey()], io())).toBe(0);
    expect(out).toEqual(
      expect.arrayContaining([
        'signature=verified',
        `signedBy=${signer.verifyKey.fingerprintText}`,
        `signedByKey=${signer.verifyKey.text}`,
        `install=${INSTALL}`,
      ]),
    );
  });

  describe('copies that cannot be verified', () => {
    const FOREIGN = '--allow-foreign-install';
    const UNTRUSTED = '--allow-untrusted-signer';
    const UNSIGNED = '--allow-unsigned-copy';
    const ALL = [FOREIGN, UNTRUSTED, UNSIGNED];
    const OTHER_INSTALL = 'dddd2222-aaaa-4bbb-8ccc-000000000002';
    const outDir = () => path.join(dir, 'restore');
    const reset = () => {
      out.length = 0;
      errs.length = 0;
    };

    it('refuses an unsigned copy without its own flag, and restores it with that flag', async () => {
      const side = sidecar();
      delete side.signature;
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey()], io())).toBe(3);
      expect(out).toContain('needs=unsigned');
      expect(errs.join(' ')).toMatch(/No verified copy.*NOT SIGNED.*--allow-unsigned-copy/);
      expect(await runCli(['fetch', ...confirmed('--out', outDir())], io())).toBe(3);
      // A flag admits only its own state.
      expect(await runCli(['describe', ...withKey(FOREIGN, UNTRUSTED)], io())).toBe(3);
      expect(fs.existsSync(outDir())).toBe(false);
      reset();
      expect(await runCli(['fetch', ...confirmed('--out', outDir(), UNSIGNED)], io())).toBe(0);
      expect(out).toContain('signature=unsigned');
      expect(out.some((l) => l.startsWith('signedBy='))).toBe(false);
      expect(errs.join('\n')).toMatch(/STATE: NOT SIGNED/);
      expect(errs.join('\n')).toMatch(/Not checked: who made this copy/);
      expect(fs.readFileSync(path.join(outDir(), NAME)).equals(original)).toBe(true);
    });

    it('an untrusted signer is a claim, never shown as checked, and needs its own flag', async () => {
      const side = sidecar();
      const other = generateSigningKey();
      side.signature = signManifest(manifestOf(side), other);
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey('--name', NAME)], io())).toBe(3);
      expect(out).toContain('needs=untrusted');
      expect(errs.join(' ')).toMatch(/claims the verify key .* so that claim is not checked/);
      expect(errs.join(' ')).not.toMatch(/offsite-key\.mjs trust|add it/);
      expect(await runCli(['describe', ...withKey('--name', NAME, FOREIGN, UNSIGNED)], io())).toBe(
        3,
      );
      reset();
      expect(await runCli(['describe', ...withKey('--name', NAME, UNTRUSTED)], io())).toBe(0);
      expect(out).toContain('signature=untrusted');
      expect(out).toContain(`claimedSigner=${other.verifyKey.fingerprintText}`);
      expect(out.some((l) => l.startsWith('signedBy=') || l.startsWith('install='))).toBe(false);
      expect(errs.join('\n')).toMatch(
        /STATE: SIGNER NOT CHECKED\. The copy claims the verify key .*; that claim is not checked/,
      );
    });

    it('treats every copy as untrusted when the key file has no verify key yet', async () => {
      fs.writeFileSync(keyFile, await sealKeyFile(key, PASS, { logN: 14 }));
      expect(await runCli(['describe', ...withKey()], io())).toBe(3);
      expect(out).toContain('needs=untrusted');
      expect(errs.join(' ')).toMatch(/holds no verify key yet.*offsite-key.mjs trust/);
      reset();
      expect(await runCli(['describe', ...withKey(UNTRUSTED)], io())).toBe(0);
      expect(out).toContain('signature=untrusted');
    });

    it('a copy signed for another portal install needs its own flag, and says what was checked', async () => {
      const side = sidecar();
      side.signature = signManifest({ ...manifestOf(side), install: OTHER_INSTALL }, signer);
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey('--name', NAME)], io())).toBe(3);
      expect(out).toContain('needs=foreign');
      expect(errs.join(' ')).toMatch(/SIGNED FOR ANOTHER PORTAL INSTALL.*--allow-foreign-install/);
      expect(
        await runCli(['describe', ...withKey('--name', NAME, UNTRUSTED, UNSIGNED)], io()),
      ).toBe(3);
      reset();
      expect(await runCli(['describe', ...withKey('--name', NAME, FOREIGN)], io())).toBe(0);
      expect(out).toContain('signature=foreign');
      expect(out).toContain(`signedBy=${signer.verifyKey.fingerprintText}`);
      expect(out).toContain(`install=${OTHER_INSTALL}`);
      expect(errs.join('\n')).toMatch(/STATE: SIGNED FOR ANOTHER PORTAL INSTALL/);
      expect(errs.join('\n')).toMatch(/Not checked: that the portal this folder belongs to/);
      reset();
      expect(await runCli(['fetch', ...confirmed('--out', outDir(), FOREIGN)], io())).toBe(0);
      expect(fs.readFileSync(path.join(outDir(), NAME)).equals(original)).toBe(true);
    });

    it('a foreign copy is checked against its signed record, never the unsigned sidecar fields', async () => {
      const side = sidecar();
      side.signature = signManifest({ ...manifestOf(side), install: OTHER_INSTALL }, signer);
      // The archive is changed, and the plain sidecar fields made to match it.
      const obj = remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!;
      const body = Buffer.from(obj.body);
      body[200]! ^= 1;
      obj.body = body;
      side.sealedSha256 = createHash('sha256').update(body).digest('hex');
      side.sealedBytes = body.length;
      setSidecar(NAME, side);
      expect(await runCli(['fetch', ...confirmed('--out', outDir(), FOREIGN)], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/does not match the checksum in its signed record/);
      expect(fs.readdirSync(outDir())).toEqual([]);
    });

    it('with no verified copy, prefers a foreign copy, then an untrusted one, then an unsigned one', async () => {
      // The real copy loses its signature (unsigned, the newest of all).
      const oldestForeign = 'backup-2026-11-18T02-00-00-000-cccccccc.tar.gz';
      const untrusted = 'backup-2026-11-20T02-00-00-000-cccccccc.tar.gz';
      plantSigned(oldestForeign, signer, { install: OTHER_INSTALL });
      plantSigned(untrusted, generateSigningKey());
      const side = sidecar();
      delete side.signature;
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey(...ALL)], io())).toBe(0);
      expect(out).toContain(`name=${oldestForeign}`);
      expect(out).toContain('signature=foreign');
      // Only the foreign flag is enough for that choice; the others are not.
      reset();
      expect(await runCli(['describe', ...withKey(UNTRUSTED, UNSIGNED)], io())).toBe(3);
      expect(out).toContain('needs=foreign');
      // Without a foreign copy, the untrusted one beats the newer unsigned one.
      remote.objects.delete(sideKey(oldestForeign));
      reset();
      expect(await runCli(['describe', ...withKey(...ALL)], io())).toBe(0);
      expect(out).toContain(`name=${untrusted}`);
      expect(out).toContain('signature=untrusted');
      remote.objects.delete(sideKey(untrusted));
      reset();
      expect(await runCli(['describe', ...withKey(...ALL)], io())).toBe(0);
      expect(out).toContain(`name=${NAME}`);
      expect(out).toContain('signature=unsigned');
    });

    it.each([
      ['a changed signed field', { bytes: '1' }],
      ['a renamed copy', { name: 'archives/backup-2026-11-20T02-00-00-000-cccccccc.tar.gz.enc' }],
      ['a copy moved from another folder', { prefix: 'gratisgis-other/' }],
    ])('never uses %s, even with every flag', async (_label, change) => {
      const side = sidecar();
      side.signature = signManifest({ ...manifestOf(side), ...change }, signer);
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey('--name', NAME, ...ALL)], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/Refusing this copy: The signature is for another copy/);
      expect(
        await runCli(['fetch', ...confirmed('--out', outDir(), '--name', NAME, ...ALL)], io()),
      ).toBe(1);
      expect(fs.existsSync(outDir())).toBe(false);
    });

    it('never uses a manifest changed after signing, even with every flag', async () => {
      const side = sidecar();
      const sig = side.signature as { manifest: string };
      sig.manifest = sig.manifest.replace(/created=2026/, 'created=2027');
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey('--name', NAME, ...ALL)], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/signature does not verify/);
    });

    it('never uses a sidecar swapped in from another copy', async () => {
      const other = 'backup-2026-11-23T02-00-00-000-cccccccc.tar.gz';
      plantSigned(other);
      // Copy A gets the sidecar that was signed for copy B.
      setSidecar(NAME, sidecar(other));
      expect(await runCli(['describe', ...withKey('--name', NAME, ...ALL)], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/the name does not match/);
    });

    it('picks the newest verified copy over newer unsigned or badly signed ones', async () => {
      const older = 'backup-2026-11-20T02-00-00-000-cccccccc.tar.gz';
      plantSigned(older);
      // A newer copy is badly signed; the real copy loses its signature.
      const bad = 'backup-2026-11-24T09-00-00-000-cccccccc.tar.gz';
      plantSigned(bad, signer, { bytes: '7' });
      const side = sidecar();
      delete side.signature;
      setSidecar(NAME, side);
      expect(await runCli(['describe', ...withKey(...ALL)], io())).toBe(0);
      expect(out).toContain(`name=${older}`);
      expect(out).toContain('signature=verified');
      expect(errs.join('\n')).toMatch(new RegExp(`Skipped ${bad.slice(0, 30)}.*BAD SIGNATURE`));
      expect(errs.join('\n')).toMatch(new RegExp(`Skipped ${NAME.slice(0, 30)}.*NOT SIGNED`));
    });
  });

  it('refuses a wrong passphrase before downloading, and never prints it', async () => {
    stdin = 'the wrong passphrase entirely\n';
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...withKey('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/did not open/);
    expect(fs.existsSync(outDir)).toBe(false);
    expect([...out, ...errs].join(' ')).not.toContain('wrong passphrase entirely');
  });

  it('says which key a copy needs when given another one', async () => {
    const other = generateOffsiteKeyPair();
    fs.writeFileSync(
      keyFile,
      await sealKeyFile(other, PASS, { logN: 14, verifyKeys: [signer.verifyKey.text] }),
    );
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...confirmed('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toContain(key.publicKey.fingerprintText);
    expect(errs.join(' ')).toContain(other.publicKey.fingerprintText);
  });

  it('never takes the passphrase as an argument', async () => {
    expect(
      await runCli(['fetch', '--out', dir, '--key-file', keyFile, '--passphrase', PASS], io()),
    ).toBe(1);
    expect(errs.join(' ')).toMatch(/standard input/);
  });

  it('says which settings are missing', async () => {
    delete ENV.BACKUP_OFFSITE_BUCKET;
    try {
      expect(await runCli(['list'], io())).toBe(1);
      expect(errs.join(' ')).toContain('BACKUP_OFFSITE_BUCKET');
    } finally {
      ENV.BACKUP_OFFSITE_BUCKET = 'offsite-bucket';
    }
  });

  it('puts the archived files back with their content types, then counts them', async () => {
    expect(await runCli(['put-objects', '--archive', path.join(dir, 'local', NAME)], io())).toBe(0);
    expect(out).toContain('objects=2');
    expect(local.objects.get('items/a/photo.jpg')!.contentType).toBe('image/jpeg');
    expect(local.objects.get('top.txt')!.body.toString()).toBe('hello');
    // The unpacked copy is removed.
    expect(fs.readdirSync(path.join(dir, 'local'))).toEqual([NAME]);
    out.length = 0;
    expect(await runCli(['count-objects'], io())).toBe(0);
    expect(out).toEqual(['objects=2']);
  });

  it('describe names the copy a restore would use, with its date, size and key', async () => {
    expect(await runCli(['describe', ...withKey()], io())).toBe(0);
    expect(out).toEqual(
      expect.arrayContaining([
        `name=${NAME}`,
        'created=2026-11-24T02:00:00.000Z',
        `fingerprint=${key.publicKey.fingerprintText}`,
      ]),
    );
    const bytes = Number(out.find((l) => l.startsWith('bytes='))!.slice(6));
    expect(bytes).toBe(remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!.body.length);
    expect(out.find((l) => l.startsWith('suspect='))).toBeUndefined();
  });

  it('lists, describes and fetches a copy that was uploaded again under a new name', async () => {
    const again = NAME.replace('.tar.gz', '-r2.tar.gz');
    plantSigned(again);
    // Only the second attempt is complete now.
    remote.objects.delete(sideKey(NAME));
    expect(await runCli(['list'], io())).toBe(0);
    expect(out).toContain(`latest=${again}`);
    out.length = 0;
    expect(await runCli(['describe', ...withKey()], io())).toBe(0);
    expect(out).toEqual(expect.arrayContaining([`name=${again}`, 'signature=verified']));
    out.length = 0;
    const outDir = path.join(dir, 'again');
    expect(
      await runCli(['fetch', ...withKey('--out', outDir, '--confirm-copy', again)], io()),
    ).toBe(0);
    expect(out).toContain(`archive=${path.join(outDir, again)}`);
    expect(fs.readFileSync(path.join(outDir, again)).equals(original)).toBe(true);
    expect(await runCli(['describe', ...withKey('--name', `${NAME}.r2`)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/--name must be a copy name/);
  });

  it('downloads nothing until the copy is confirmed by its name', async () => {
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...withKey('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(
      new RegExp(`--confirm-copy ${NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    expect(out).toContain(`name=${NAME}`);
    expect(fs.existsSync(outDir)).toBe(false);
    errs.length = 0;
    expect(
      await runCli(
        ['fetch', ...withKey('--out', outDir, '--confirm-copy', 'backup-something-else')],
        io(),
      ),
    ).toBe(1);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  describe('a copy dated in the future', () => {
    const PLANTED = 'backup-2099-01-01T00-00-00-000-dddddddd.tar.gz';
    beforeEach(() => {
      // A complete, even correctly signed, copy whose name claims a later date.
      plantSigned(PLANTED);
    });

    it('is never picked as the newest copy, and list says it was set aside', async () => {
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain(`latest=${NAME}`);
      expect(errs.join('\n')).toMatch(new RegExp(`set aside.*${PLANTED.slice(0, 20)}`));
      out.length = 0;
      expect(await runCli(['describe', ...withKey()], io())).toBe(0);
      expect(out).toContain(`name=${NAME}`);
    });

    it('is used only when named, and then flagged', async () => {
      expect(await runCli(['describe', ...withKey('--name', PLANTED)], io())).toBe(0);
      expect(out).toContain(`name=${PLANTED}`);
      expect(out).toContain('suspect=future');
    });

    it('a copy whose sidecar belongs to another copy is refused when named', async () => {
      setSidecar(PLANTED, sidecar());
      expect(await runCli(['describe', ...withKey('--name', PLANTED)], io())).toBe(1);
    });
  });

  it('ignores names in sub-folders of archives/', async () => {
    const src = remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!;
    const nested = 'backup-2026-11-24T09-00-00-000-eeeeeeee.tar.gz';
    remote.objects.set(`${PREFIX}archives/x/${nested}.enc`, src);
    remote.objects.set(`${PREFIX}archives/x/${nested}.enc.json`, src);
    expect(await runCli(['list'], io())).toBe(0);
    expect(out).toContain(`latest=${NAME}`);
    expect(errs.join(' ')).not.toContain(nested);
  });

  describe('finding the portal folder', () => {
    const move = (to: string, from = PREFIX) => {
      for (const [k, v] of [...remote.objects]) {
        if (!k.startsWith(from)) continue;
        remote.objects.delete(k);
        remote.objects.set(`${to}${k.slice(from.length)}`, v);
      }
    };
    afterEach(() => {
      delete ENV.BACKUP_OFFSITE_PREFIX;
    });

    it('finds a nested folder, with or without a parent prefix given', async () => {
      move('backups/site-a/portal/');
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain('prefix=backups/site-a/portal/');
      out.length = 0;
      ENV.BACKUP_OFFSITE_PREFIX = 'backups/';
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain('prefix=backups/site-a/portal/');
      out.length = 0;
      ENV.BACKUP_OFFSITE_PREFIX = 'backups/site-a/portal';
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain('prefix=backups/site-a/portal/');
    });

    it('stops and lists what it saw when no folder is found, never guessing one', async () => {
      move('elsewhere/');
      remote.objects.delete('elsewhere/gratisgis-install.json');
      expect(await runCli(['list'], io())).toBe(1);
      expect(errs.join(' ')).toMatch(
        /No portal folder.*Looked in: \(top of the bucket\), elsewhere\//,
      );
      expect(out).toEqual([]);
      errs.length = 0;
      ENV.BACKUP_OFFSITE_PREFIX = 'gratisgis/';
      expect(await runCli(['list'], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/in or under gratisgis\//);
    });

    it('restores from every folder the page accepts, and the restore script accepts it too', async () => {
      const script = path.resolve(__dirname, '../../../../infra/restore-from-offsite.sh');
      const shellAccepts = (p: string) => {
        try {
          execFileSync('bash', ['-c', 'source "$GG_SCRIPT" && ggo_valid_prefix "$GG_PREFIX"'], {
            stdio: 'ignore',
            env: {
              PATH: process.env.PATH,
              GG_RESTORE_LIB_ONLY: '1',
              GG_SCRIPT: script,
              GG_PREFIX: p,
            },
          });
          return true;
        } catch {
          return false;
        }
      };
      const pageAccepts = (p: string) => {
        try {
          validateOffsitePatch(
            { prefix: p },
            endpointPolicy(() => undefined),
          );
          return true;
        } catch {
          return false;
        }
      };
      const candidates = [
        'gratisgis-main/',
        'site_a.2026/portal-1',
        '/Backups/Site.A/x_y-z/',
        '...a/',
        'a..b/c/',
        'my backups/',
        'site@a/',
        'a+b/',
        'sauvegardes-été/',
        'a:b/',
        "a'b/",
        'a//b/',
        'a/../b/',
      ];
      const accepted = candidates.filter(pageAccepts);
      expect(accepted).toEqual([
        'gratisgis-main/',
        'site_a.2026/portal-1',
        '/Backups/Site.A/x_y-z/',
        '...a/',
        'a..b/c/',
      ]);
      let from = PREFIX;
      for (const given of accepted) {
        const folder = normalizePrefix(given);
        expect(shellAccepts(folder)).toBe(true);
        move(folder, from);
        from = folder;
        ENV.BACKUP_OFFSITE_PREFIX = given;
        out.length = 0;
        errs.length = 0;
        expect(await runCli(['list'], io())).toBe(0);
        expect(out).toContain(`prefix=${folder}`);
        expect(out).toContain(`latest=${NAME}`);
        // The copy was signed for its first folder: moved, it is refused.
        out.length = 0;
        expect(
          await runCli(
            [
              'describe',
              ...withKey(
                '--allow-foreign-install',
                '--allow-untrusted-signer',
                '--allow-unsigned-copy',
              ),
            ],
            io(),
          ),
        ).toBe(1);
        expect(errs.join(' ')).toMatch(/the folder does not match/);
      }
      for (const refused of candidates.filter((c) => !pageAccepts(c))) {
        expect(shellAccepts(refused)).toBe(false);
      }
    });

    it('refuses an empty prefix', async () => {
      ENV.BACKUP_OFFSITE_PREFIX = '/';
      expect(await runCli(['list'], io())).toBe(1);
      expect(errs.join(' ')).toMatch(/cannot be empty/);
    });
  });

  it('refuses an archive name that is not one', async () => {
    expect(await runCli(['fetch', ...withKey('--out', dir, '--name', '../etc/passwd')], io())).toBe(
      1,
    );
  });
});
