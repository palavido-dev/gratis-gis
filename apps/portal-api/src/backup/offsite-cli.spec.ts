// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';

import { FakeS3 } from '../testing/fake-s3.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import type { BackupService } from './backup.service.js';
import { runCli, type CliIo } from './offsite-cli.js';
import { normalizePrefix, validateOffsitePatch } from './offsite-config.js';
import { endpointPolicy } from './offsite-endpoint.js';
import { generateOffsiteKeyPair, sealKeyFile, type OffsitePrivateKey } from './offsite-crypto.js';
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
    Object.assign(process.env, ENV, { BACKUP_OFFSITE_PUBLIC_KEY: key.publicKey.text });
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
    const handle = await svc.startUpload(String(runs[0]!.id), 9);
    await handle?.done;
    process.env = saved;
    expect(runs[0]!.offsiteStatus).toBe('succeeded');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the portal folder when no prefix is set, and lists the newest complete copy', async () => {
    expect(await runCli(['list'], io())).toBe(0);
    expect(out).toContain(`prefix=${PREFIX}`);
    expect(out).toContain(`latest=${NAME}`);
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

  it('check-key opens the key file and prints its fingerprint', async () => {
    stdin = `${PASS}\r\n`;
    expect(await runCli(['check-key', '--key-file', keyFile, '--passphrase-stdin'], io())).toBe(0);
    expect(out).toEqual([`fingerprint=${key.publicKey.fingerprintText}`]);
  });

  it('takes the key file and passphrase together on standard input', async () => {
    stdin = `${fs.readFileSync(keyFile).toString('base64')}\n${PASS}\r\n`;
    expect(await runCli(['check-key', '--key-stdin'], io())).toBe(0);
    expect(out).toEqual([`fingerprint=${key.publicKey.fingerprintText}`]);
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
    fs.writeFileSync(path.join(outDir, `.partial-${NAME}`), 'left over');
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

  it('refuses a copy whose checksum does not match the sidecar, and leaves nothing behind', async () => {
    const sideKey = `${PREFIX}archives/${NAME}.enc.json`;
    const side = JSON.parse(remote.objects.get(sideKey)!.body.toString()) as Record<
      string,
      unknown
    >;
    side.sealedSha256 = '0'.repeat(64);
    remote.objects.get(sideKey)!.body = Buffer.from(JSON.stringify(side));
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...confirmed('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/checksum/);
    expect(fs.readdirSync(outDir)).toEqual([]);
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
    fs.writeFileSync(keyFile, await sealKeyFile(other, PASS, { logN: 14 }));
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
    expect(await runCli(['describe'], io())).toBe(0);
    expect(out).toEqual(
      expect.arrayContaining([
        'kind=archive',
        `name=${NAME}`,
        'created=2026-11-24T02:00:00.000Z',
        `fingerprint=${key.publicKey.fingerprintText}`,
      ]),
    );
    const bytes = Number(out.find((l) => l.startsWith('bytes='))!.slice(6));
    expect(bytes).toBe(remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!.body.length);
    expect(out.find((l) => l.startsWith('suspect='))).toBeUndefined();
  });

  it('describe picks the newer of the newest archive and the newest mirror run', async () => {
    const run = '2026-11-24T05-00-00-000-abababab';
    remote.objects.set(`${PREFIX}mirror/runs/${run}/done.json`, {
      body: Buffer.from(JSON.stringify({ keyFingerprint: key.publicKey.fingerprintText })),
      lastModified: new Date(),
      etag: '"d"',
    });
    expect(await runCli(['describe'], io())).toBe(0);
    expect(out).toEqual(expect.arrayContaining(['kind=mirror', `name=${run}`]));
    out.length = 0;
    // fetch refuses to download a mirror run; it names the right command.
    expect(await runCli(['fetch', ...withKey('--out', path.join(dir, 'r'))], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/use fetch-mirror/);
  });

  it('downloads nothing until the copy is confirmed by its name', async () => {
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', ...withKey('--out', outDir)], io())).toBe(1);
    expect(errs.join(' ')).toMatch(new RegExp(`--confirm-copy ${NAME.replace(/\./g, '\\.')}`));
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
      // A complete-looking copy whose name claims a later date.
      const src = remote.objects.get(`${PREFIX}archives/${NAME}.enc`)!;
      const side = remote.objects.get(`${PREFIX}archives/${NAME}.enc.json`)!;
      remote.objects.set(`${PREFIX}archives/${PLANTED}.enc`, { ...src, lastModified: new Date() });
      remote.objects.set(`${PREFIX}archives/${PLANTED}.enc.json`, {
        ...side,
        lastModified: new Date(),
      });
    });

    it('is never picked as the newest copy, and list says it was set aside', async () => {
      expect(await runCli(['list'], io())).toBe(0);
      expect(out).toContain(`latest=${NAME}`);
      expect(errs.join('\n')).toMatch(new RegExp(`set aside.*${PLANTED.slice(0, 20)}`));
      out.length = 0;
      expect(await runCli(['describe'], io())).toBe(0);
      expect(out).toContain(`name=${NAME}`);
    });

    it('is used only when named, and then flagged', async () => {
      expect(await runCli(['describe', '--name', PLANTED], io())).toBe(0);
      expect(out).toContain(`name=${PLANTED}`);
      expect(out).toContain('suspect=future');
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
          execFileSync(
            'bash',
            ['-c', 'GG_RESTORE_LIB_ONLY=1 source "$0" && ggo_valid_prefix "$1"', script, p],
            { stdio: 'ignore' },
          );
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
        expect(await runCli(['describe'], io())).toBe(0);
        expect(out).toContain(`prefix=${folder}`);
        expect(out).toContain(`name=${NAME}`);
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
