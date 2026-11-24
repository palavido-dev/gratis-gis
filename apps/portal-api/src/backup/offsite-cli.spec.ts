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
import { OffsiteService } from './offsite.service.js';

const PASS = 'cli test passphrase 98765';
const NAME = 'backup-2026-11-24T02-00-00-000-cccccccc.tar.gz';

describe('offsite-cli', () => {
  const ENV: Record<string, string> = {
    BACKUP_OFFSITE_ENABLED: 'true',
    BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
    BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
    BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'cli-secret-value-1',
    BACKUP_OFFSITE_PASSPHRASE: PASS,
  };
  let dir: string;
  let remote: FakeS3;
  let local: FakeS3;
  let out: string[];
  let errs: string[];
  let stdin: string;
  let original: Buffer;

  const io = (): CliIo => ({
    out: (l) => out.push(l),
    err: (l) => errs.push(l),
    stdin: async () => stdin,
    env: (n) => ENV[n],
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

    // Make a real off-site copy with the service.
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
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
    const svc = new OffsiteService(
      makePrisma(runs, emptyConfigRow()) as never,
      {
        configRow: async () => emptyConfigRow(),
        onRunSucceeded: jest.fn(),
      } as unknown as BackupService,
    );
    svc.clientFactory = () => remote;
    svc.sealCost = 14;
    const pending: unknown = await svc.startUpload(String(runs[0]!.id), 9);
    if (pending instanceof Promise) await pending;
    process.env = saved;
    expect(runs[0]!.offsiteStatus).toBe('succeeded');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the newest complete copy', async () => {
    expect(await runCli(['list'], io())).toBe(0);
    expect(out).toContain(`latest=${NAME}`);
  });

  it('fetches, verifies and decrypts the archive byte for byte', async () => {
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', '--passphrase-stdin', '--out', outDir], io())).toBe(0);
    expect(out).toEqual([
      `archive=${path.join(outDir, NAME)}`,
      'database=gratisgis',
      'objects=2',
      'portalVersion=1.8.0',
    ]);
    expect(fs.readFileSync(path.join(outDir, NAME)).equals(original)).toBe(true);
    expect(fs.statSync(path.join(outDir, NAME)).mode & 0o777).toBe(0o600);
  });

  it('refuses a copy whose checksum does not match the sidecar, and leaves nothing behind', async () => {
    const key = `gratisgis/archives/${NAME}.enc.json`;
    const side = JSON.parse(remote.objects.get(key)!.body.toString()) as Record<string, unknown>;
    side.sealedSha256 = '0'.repeat(64);
    remote.objects.get(key)!.body = Buffer.from(JSON.stringify(side));
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', '--passphrase-stdin', '--out', outDir], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/checksum/);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('refuses a wrong passphrase and never prints the passphrase', async () => {
    stdin = 'the wrong passphrase entirely\n';
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch', '--passphrase-stdin', '--out', outDir], io())).toBe(1);
    expect(errs.join(' ')).toMatch(/did not verify/);
    expect(fs.readdirSync(outDir)).toEqual([]);
    expect([...out, ...errs].join(' ')).not.toContain('wrong passphrase entirely');
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

  it('refuses an archive name that is not one', async () => {
    expect(
      await runCli(['fetch', '--passphrase-stdin', '--out', dir, '--name', '../etc/passwd'], io()),
    ).toBe(1);
  });
});
