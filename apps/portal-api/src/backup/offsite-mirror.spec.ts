// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { _resetKeyCacheForTests } from '../items/credential-cipher.js';
import { FakeS3 } from '../testing/fake-s3.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import type { BackupService } from './backup.service.js';
import { runCli, type CliIo } from './offsite-cli.js';
import {
  generateOffsiteKeyPair,
  sealKeyFile,
  sealStream,
  unsealStream,
  type OffsitePrivateKey,
} from './offsite-crypto.js';
import {
  downloadChecked,
  INDEX_LEFTOVER_AGE_MS,
  MAX_SET_ASIDE_CHECKED,
  mirrorRunId,
  mirrorSourceId,
  newMirrorObjectName,
  PackedListing,
  parseIndexLine,
  sweepIndexLeftovers,
} from './offsite-mirror.js';
import { OffsiteService } from './offsite.service.js';

const KEY_PASS = 'mirror key passphrase 0123';
const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = 'site/';
const OBJECTS = `${PREFIX}mirror/objects/`;

async function collect(it: AsyncIterable<unknown>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(Buffer.from(b as Buffer));
  return Buffer.concat(out);
}

function stamp(d: Date) {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

describe('mirror file names', () => {
  const k1 = randomBytes(32);
  const fp = randomBytes(16);
  it('the source id is stable, keyed, and changes with the file or the public key', () => {
    const a = mirrorSourceId(k1, fp, 'items/a/photo.jpg', 10, '"e1"');
    expect(a).toBe(mirrorSourceId(k1, fp, 'items/a/photo.jpg', 10, '"e1"'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mirrorSourceId(k1, fp, 'items/a/photo.jpg', 10, '"e2"')).not.toBe(a);
    expect(mirrorSourceId(k1, fp, 'items/a/photo.jpg', 11, '"e1"')).not.toBe(a);
    expect(mirrorSourceId(k1, randomBytes(16), 'items/a/photo.jpg', 10, '"e1"')).not.toBe(a);
    // Another server's key gives other ids, so an id cannot be
    // checked against a guessed file.
    expect(mirrorSourceId(randomBytes(32), fp, 'items/a/photo.jpg', 10, '"e1"')).not.toBe(a);
    expect(a).not.toBe(
      createHash('sha256').update('items/a/photo.jpg\u000010\u0000"e1"').digest('hex'),
    );
  });

  it('every upload gets a new name, never one the bucket lists', () => {
    const p = new PackedListing();
    const taken = `${'a'.repeat(64)}.enc`;
    p.add(taken, 1);
    p.finish();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const n = newMirrorObjectName(p);
      expect(n).toMatch(/^[0-9a-f]{64}\.enc$/);
      expect(n).not.toBe(taken);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
    // A listing that holds the first name drawn makes it draw again.
    let calls = 0;
    const fakeListing = { get: () => (calls++ === 0 ? 1 : undefined) };
    newMirrorObjectName(fakeListing);
    expect(calls).toBe(2);
  });
});

describe('sweepIndexLeftovers', () => {
  it('removes index folders unchanged for a day, and nothing else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-idx-'));
    try {
      const now = Date.now();
      const old = new Date(now - INDEX_LEFTOVER_AGE_MS - 60_000);
      const make = (name: string, when: Date, fileWhen = when) => {
        const d = path.join(dir, name);
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'objects.jsonl'), '{}\n');
        fs.utimesSync(path.join(d, 'objects.jsonl'), fileWhen, fileWhen);
        fs.utimesSync(d, when, when);
      };
      make('.offsite-index-old', old);
      make('.offsite-index-fresh', new Date(now));
      make('.offsite-index-still-writing', old, new Date(now));
      make('.stage-other', old);
      fs.writeFileSync(path.join(dir, '.offsite-index-file'), 'x');
      fs.utimesSync(path.join(dir, '.offsite-index-file'), old, old);

      expect(await sweepIndexLeftovers(dir, now)).toBe(1);
      expect(fs.readdirSync(dir).sort()).toEqual([
        '.offsite-index-file',
        '.offsite-index-fresh',
        '.offsite-index-still-writing',
        '.stage-other',
      ]);
      expect(await sweepIndexLeftovers(path.join(dir, 'missing'), now)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs when the service starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-idx-'));
    try {
      const d = path.join(dir, '.offsite-index-crashed');
      fs.mkdirSync(d);
      const old = new Date(Date.now() - 2 * INDEX_LEFTOVER_AGE_MS);
      fs.utimesSync(d, old, old);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const svc = new OffsiteService(
        makePrisma([], emptyConfigRow()) as never,
        { getConfig: async () => ({ archiveDirectory: dir }) } as unknown as BackupService,
      );
      const spy = jest.spyOn(svc, 'sweepIndexLeftovers');
      svc.onApplicationBootstrap();
      svc.onModuleDestroy();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await spy.mock.results[0]!.value).toBe(1);
      expect(fs.existsSync(d)).toBe(false);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PackedListing', () => {
  it('finds each name and size, in any listing order, and ignores other names', () => {
    const names = Array.from({ length: 3000 }, () => `${randomBytes(32).toString('hex')}.enc`);
    const p = new PackedListing();
    names.forEach((n, i) => p.add(n, i * 7));
    p.add('not-a-mirror-name.enc', 1);
    p.add(`${'A'.repeat(64)}.enc`, 1);
    p.finish();
    expect(p.size).toBe(3000);
    names.forEach((n, i) => expect(p.get(n)).toBe(i * 7));
    expect(p.get(`${'0'.repeat(64)}.enc`)).toBeUndefined();
    expect(p.get('not-a-mirror-name.enc')).toBeUndefined();
    // Sorted input, the usual case, needs no sort.
    const sorted = new PackedListing();
    for (const n of [...names].sort()) sorted.add(n, 1);
    sorted.finish();
    expect(sorted.get(names[0]!)).toBe(1);
  });

  it('keeps about 40 bytes per listed file', () => {
    const p = new PackedListing();
    for (let i = 0; i < 10_000; i += 1) p.add(`${randomBytes(32).toString('hex')}.enc`, i);
    p.finish();
    const held = (p as unknown as { buf: Buffer }).buf.length;
    expect(held).toBeLessThanOrEqual(10_000 * 40 * 2);
  });
});

describe('file index lines', () => {
  const good = { k: 'a/b.txt', o: `${'a'.repeat(64)}.enc`, s: 3, z: 134, h: 'b'.repeat(64) };
  it('reads a line with its checksum', () => {
    expect(parseIndexLine(JSON.stringify(good), true)).toEqual(good);
  });
  it('a signed index must carry the checksum of every file', () => {
    const noHash: Partial<typeof good> = { ...good };
    delete noHash.h;
    expect(() => parseIndexLine(JSON.stringify(noHash), true)).toThrow(/without its checksum/);
    expect(parseIndexLine(JSON.stringify(noHash), false)).toEqual(noHash);
  });
  it.each([
    { ...good, o: '../x.enc' },
    { ...good, h: 'XYZ' },
    { ...good, s: -1 },
    { ...good, k: '' },
  ])('refuses a damaged line %#', (line) => {
    expect(() => parseIndexLine(JSON.stringify(line), true)).toThrow(/damaged/);
  });
});

describe('downloadChecked', () => {
  it('stops as soon as an object is larger than its record, writing no more than the record allows', async () => {
    const s3 = new FakeS3();
    s3.objects.set('o', { body: randomBytes(4096), lastModified: new Date(), etag: '"o"' });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-dl-'));
    try {
      const fh = await fs.promises.open(path.join(d, 'x'), 'wx+');
      try {
        await expect(
          downloadChecked(s3 as never, 'b', 'o', fh, { bytes: 100, sha256: '0'.repeat(64) }),
        ).rejects.toThrow(/larger than the 100 bytes its record says/);
      } finally {
        await fh.close();
      }
      expect(fs.statSync(path.join(d, 'x')).size).toBeLessThanOrEqual(100);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('off-site mirror mode', () => {
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
  let dir: string;
  let remote: FakeS3;
  let source: FakeS3;
  let runs: Row[];
  let objects: Row[];
  let mirrorRuns: Row[];
  let configRow: Row;
  let svc: OffsiteService;
  let key: OffsitePrivateKey;
  const dump = randomBytes(50_000);

  function makeArchive(name: string) {
    const src = path.join(dir, `src-${name}`);
    fs.mkdirSync(path.join(src, 'postgres'), { recursive: true });
    fs.writeFileSync(
      path.join(src, 'manifest.json'),
      JSON.stringify({
        version: 1,
        databases: ['gratisgis'],
        minio: { objectCount: 3, totalBytes: 100 * GB },
      }),
    );
    fs.writeFileSync(path.join(src, 'postgres', 'gratisgis.dump'), dump);
    execFileSync('tar', [
      '-czf',
      path.join(dir, name),
      '-C',
      src,
      'manifest.json',
      'postgres/gratisgis.dump',
    ]);
    fs.rmSync(src, { recursive: true, force: true });
  }

  function addRun(id: string, at: Date) {
    const filename = `backup-${stamp(at)}-${id.slice(0, 8)}.tar.gz`;
    makeArchive(filename);
    runs.push({
      id,
      status: 'succeeded',
      filename,
      archiveDirectory: dir,
      startedAt: at,
      offsiteStatus: null,
      offsiteStartedAt: null,
      offsiteFinishedAt: null,
      offsiteHeartbeatAt: null,
    });
    return runs.at(-1)!;
  }

  async function upload(id: string) {
    const handle = await svc.startUpload(id, 100 * GB);
    await handle?.done;
    return runs.find((r) => r.id === id)!;
  }

  function doneOf(run: Row) {
    const runId = mirrorRunId(String(run.filename), String(run.id), run.startedAt as Date);
    return JSON.parse(
      remote.objects.get(`${PREFIX}mirror/runs/${runId}/done.json`)!.body.toString(),
    ) as { uploaded: number; reused: number; keyFingerprint: string; format: string };
  }

  async function sourcePut(k: string, body: string, type: string) {
    await source.send({
      constructor: { name: 'PutObjectCommand' },
      input: { Bucket: 'gratisgis', Key: k, Body: Buffer.from(body), ContentType: type },
    } as never);
  }

  const files = () => [...remote.objects.keys()].filter((k) => k.startsWith(OBJECTS));

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    key = generateOffsiteKeyPair();
    Object.assign(process.env, {
      BACKUP_OFFSITE_ENABLED: 'true',
      BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
      BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
      BACKUP_OFFSITE_PREFIX: PREFIX,
      BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'mirror-secret-value-1',
      BACKUP_OFFSITE_PUBLIC_KEY: key.publicKey.text,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    _resetKeyCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-mirror-'));
    remote = new FakeS3();
    source = new FakeS3();
    runs = [];
    objects = [];
    mirrorRuns = [];
    configRow = { ...emptyConfigRow(), offsiteInstallId: '11112222-aaaa-4bbb-8ccc-000000000001' };
    const backup = {
      configRow: jest.fn(async () => configRow),
      getConfig: jest.fn(async () => ({ archiveDirectory: dir })),
      onRunSucceeded: jest.fn(),
      sourceStore: () => ({ s3: source, bucket: 'gratisgis' }),
    } as unknown as BackupService;
    svc = new OffsiteService(makePrisma(runs, configRow, objects, mirrorRuns) as never, backup, {
      announceOffsite: jest.fn(),
    } as never);
    svc.clientFactory = () => remote;
    svc.endpointCheck = async () => undefined;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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

  it('uploads only new or changed files, from the local index, and hides names', async () => {
    await sourcePut('items/a/photo.jpg', 'AAAA', 'image/jpeg');
    await sourcePut('items/b/data.json', '{"v":1}', 'application/json');
    const r1 = await upload(
      addRun('11111111-0000-4000-8000-000000000001', new Date(Date.now() - 2 * DAY)).id as string,
    );
    expect(r1).toMatchObject({ offsiteStatus: 'succeeded', offsiteMode: 'mirror' });
    expect(files()).toHaveLength(2);
    expect(objects).toHaveLength(2);
    for (const k of remote.objects.keys()) {
      expect(k).not.toContain('photo.jpg');
      expect(k).not.toContain('data.json');
    }
    // Names are not content hashes.
    for (const body of ['AAAA', '{"v":1}']) {
      const h = createHash('sha256').update(body).digest('hex');
      expect(files().some((k) => k.includes(h))).toBe(false);
    }
    expect(doneOf(r1)).toMatchObject({
      uploaded: 2,
      reused: 0,
      format: 'GROF1',
      keyFingerprint: key.publicKey.fingerprintText,
    });
    expect(String(configRow.offsiteNameKeyEncrypted)).toBeTruthy();

    // Second run: one changed, one new, one unchanged. The bucket is
    // never read back: only listed.
    await sourcePut('items/b/data.json', '{"v":2}', 'application/json');
    await sourcePut('items/c/new.txt', 'new', 'text/plain');
    remote.calls.length = 0;
    const r2 = await upload(
      addRun('22222222-0000-4000-8000-000000000002', new Date(Date.now() - DAY)).id as string,
    );
    expect(doneOf(r2)).toMatchObject({ uploaded: 2, reused: 1 });
    expect(files()).toHaveLength(4);
    // The folder marker: once at the start, and again before each
    // clean-up step; then the two runs' plain done markers, to check
    // their signatures. No encrypted file is read back.
    expect(remote.calls.filter((c) => c === 'GetObjectCommand')).toHaveLength(5);
  });

  it('a lost local index means upload everything, never a failure or a delete', async () => {
    await sourcePut('a.txt', 'a', 'text/plain');
    await sourcePut('b.txt', 'b', 'text/plain');
    await upload(
      addRun('33333333-0000-4000-8000-000000000003', new Date(Date.now() - 2 * DAY)).id as string,
    );
    objects.splice(0, objects.length);
    remote.calls.length = 0;
    const r2 = await upload(
      addRun('44444444-0000-4000-8000-000000000004', new Date(Date.now() - DAY)).id as string,
    );
    expect(r2.offsiteStatus).toBe('succeeded');
    expect(doneOf(r2)).toMatchObject({ uploaded: 2, reused: 0 });
    expect(remote.calls).not.toContain('DeleteObjectCommand');
    expect(objects).toHaveLength(2);
  });

  it('a file the index lists but the bucket lost is uploaded again', async () => {
    await sourcePut('a.txt', 'a', 'text/plain');
    await upload(
      addRun('55555555-0000-4000-8000-000000000005', new Date(Date.now() - 2 * DAY)).id as string,
    );
    remote.objects.delete(files()[0]!);
    const r2 = await upload(
      addRun('66666666-0000-4000-8000-000000000006', new Date(Date.now() - DAY)).id as string,
    );
    expect(doneOf(r2)).toMatchObject({ uploaded: 1, reused: 0 });
    expect(files()).toHaveLength(1);
  });

  it('a new public key uploads every file again; the old run still restores with the old key', async () => {
    await sourcePut('items/x/a.tif', 'TIFFDATA', 'image/tiff');
    const r1 = await upload(
      addRun('77777777-0000-4000-8000-000000000007', new Date(Date.now() - 2 * DAY)).id as string,
    );
    const next = generateOffsiteKeyPair();
    process.env.BACKUP_OFFSITE_PUBLIC_KEY = next.publicKey.text;
    const r2 = await upload(
      addRun('88888888-0000-4000-8000-000000000008', new Date(Date.now() - DAY)).id as string,
    );
    expect(doneOf(r2)).toMatchObject({
      uploaded: 1,
      reused: 0,
      keyFingerprint: next.publicKey.fingerprintText,
    });
    expect(files()).toHaveLength(2);
    // Both runs restore, each with its own key.
    for (const [run, k] of [
      [r1, key],
      [r2, next],
    ] as const) {
      const runId = mirrorRunId(String(run.filename), String(run.id), run.startedAt as Date);
      const sealed = remote.objects.get(`${PREFIX}mirror/runs/${runId}/database.dump.enc`)!.body;
      expect((await collect(unsealStream(Readable.from([sealed]), k))).equals(dump)).toBe(true);
    }
  });

  it('retention drops old runs and the files only they could refer to', async () => {
    await sourcePut('keep.txt', 'keep', 'text/plain');
    await sourcePut('gone.txt', 'gone', 'text/plain');
    await upload(
      addRun('99999999-0000-4000-8000-000000000009', new Date(Date.now() - 40 * DAY)).id as string,
    );
    source.objects.delete('gone.txt');
    // Its own retention pass runs at the end of this upload.
    await upload(
      addRun('aaaaaaaa-0000-4000-8000-00000000000a', new Date(Date.now() - DAY)).id as string,
    );

    const runFolders = new Set(
      [...remote.objects.keys()]
        .filter((k) => k.startsWith(`${PREFIX}mirror/runs/`))
        .map((k) => k.split('/')[3]),
    );
    expect(runFolders.size).toBe(1);
    expect(files()).toHaveLength(1);
    expect(objects).toHaveLength(1);
    // The removed run is forgotten too.
    expect(mirrorRuns.map((r) => r.runId)).toEqual([...runFolders]);
  });

  it('writes the file index through a temporary file and always removes it', async () => {
    await sourcePut('a.txt', 'a', 'text/plain');
    await sourcePut('b.txt', 'b', 'text/plain');
    const tmpLeft = () => fs.readdirSync(dir).filter((n) => n.startsWith('.offsite-index-'));
    const run = await upload(
      addRun('abababab-0000-4000-8000-00000000000b', new Date(Date.now() - DAY)).id as string,
    );
    expect(run.offsiteStatus).toBe('succeeded');
    expect(tmpLeft()).toEqual([]);
    // Over the size limit: the run fails, and the file still goes.
    (svc as unknown as { mirror: { maxIndexBytes: number } }).mirror.maxIndexBytes = 10;
    const second = await upload(
      addRun('cdcdcdcd-0000-4000-8000-00000000000c', new Date()).id as string,
    );
    expect(second.offsiteStatus).toBe('failed');
    expect(String(second.offsiteError)).toMatch(/file index of this mirror run would be larger/);
    expect(tmpLeft()).toEqual([]);
  });

  it('a run dated in the future never decides which files are old', async () => {
    await sourcePut('keep.txt', 'keep', 'text/plain');
    await upload(
      addRun('12121212-0000-4000-8000-000000000012', new Date(Date.now() - 40 * DAY)).id as string,
    );
    const planted = '2099-01-01T00-00-00-000-34343434';
    remote.objects.set(`${PREFIX}mirror/runs/${planted}/done.json`, {
      body: Buffer.from('{}'),
      lastModified: new Date(),
      etag: '"d"',
    });
    const before = files();
    await svc.enforceRetention(await svc.settings(), remote);
    // The 40-day-old run is still the newest good one, so its files stay.
    expect(files()).toEqual(before);
    expect(remote.objects.has(`${PREFIX}mirror/runs/${planted}/done.json`)).toBe(true);
  });

  it('does not collect files while another upload is running', async () => {
    await sourcePut('keep.txt', 'keep', 'text/plain');
    await sourcePut('gone.txt', 'gone', 'text/plain');
    // Long retention for the uploads, so their own passes keep everything.
    process.env.BACKUP_OFFSITE_RETENTION_DAYS = '365';
    try {
      await upload(
        addRun('bbbbbbbb-0000-4000-8000-00000000000b', new Date(Date.now() - 40 * DAY))
          .id as string,
      );
      source.objects.delete('gone.txt');
      await upload(
        addRun('cccccccc-0000-4000-8000-00000000000c', new Date(Date.now() - DAY)).id as string,
      );
    } finally {
      delete process.env.BACKUP_OFFSITE_RETENTION_DAYS;
    }
    expect(files()).toHaveLength(2);
    const s = await svc.settings();

    runs.push({
      id: 'live',
      status: 'succeeded',
      offsiteStatus: 'running',
      offsiteHeartbeatAt: new Date(),
    });
    await svc.enforceRetention(s, remote);
    // The old run is gone, but no file was collected.
    expect(files()).toHaveLength(2);

    runs.pop();
    await svc.enforceRetention(s, remote);
    expect(files()).toHaveLength(1);
  });

  it('"Upload again" in mirror mode only for the newest backup', async () => {
    await sourcePut('a.txt', 'a', 'text/plain');
    const older = addRun('12121212-0000-4000-8000-000000000012', new Date(Date.now() - 2 * DAY));
    const newest = addRun('13131313-0000-4000-8000-000000000013', new Date(Date.now() - DAY));
    await expect(svc.retry(older.id as string)).rejects.toThrow(/only the newest backup/);
    await expect(svc.retry(newest.id as string)).resolves.toBeUndefined();
    // Let the started upload finish before the test cleans up.
    for (let i = 0; i < 100 && newest.offsiteStatus === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(newest.offsiteStatus).toBe('succeeded');
  });

  it('checks each mirrored file against the size the source reported', async () => {
    await sourcePut('a.txt', 'abc', 'text/plain');
    source.lieAboutGetLength = true;
    const r = await upload(addRun('eeeeeeee-0000-4000-8000-00000000000e', new Date()).id as string);
    expect(r.offsiteStatus).toBe('failed');
    expect(String(r.offsiteError)).toMatch(/expected/);
  });

  it('the CLI restores a mirror run with the key file: dump to disk, files back', async () => {
    await sourcePut('items/x/a.tif', 'TIFFDATA', 'image/tiff');
    await sourcePut('items/y/b.json', '{}', 'application/json');
    await upload(
      addRun('ffffffff-0000-4000-8000-00000000000f', new Date(Date.now() - 2 * DAY)).id as string,
    );
    // A second run that reuses both files keeps their content types.
    await upload(
      addRun('f0f0f0f0-0000-4000-8000-000000000010', new Date(Date.now() - DAY)).id as string,
    );

    const keyFile = path.join(dir, 'k.ggkey');
    fs.writeFileSync(
      keyFile,
      await sealKeyFile(key, KEY_PASS, {
        logN: 14,
        verifyKeys: [String(configRow.offsiteVerifyKey)],
      }),
    );
    const local = new FakeS3();
    const out: string[] = [];
    const io: CliIo = {
      out: (l) => out.push(l),
      err: () => undefined,
      stdin: async () => `${KEY_PASS}\r\n`,
      env: (n) => process.env[n],
      readFile: async (p) => fs.readFileSync(p),
      offsite: () => remote,
      local: () => ({ s3: local, bucket: 'gratisgis' }),
    };
    const outDir = path.join(dir, 'restore');
    // Nothing is downloaded until the copy is confirmed by name.
    expect(
      await runCli(
        ['fetch-mirror', '--key-file', keyFile, '--passphrase-stdin', '--out', outDir],
        io,
      ),
    ).toBe(1);
    expect(fs.existsSync(outDir)).toBe(false);
    const newest = out.find((l) => l.startsWith('name='))!.slice(5);
    expect(out).toContain(`fingerprint=${key.publicKey.fingerprintText}`);
    out.length = 0;
    const confirm = ['--confirm-copy', newest];
    expect(
      await runCli(
        ['fetch-mirror', '--key-file', keyFile, '--passphrase-stdin', '--out', outDir, ...confirm],
        io,
      ),
    ).toBe(0);
    const dumpPath = out.find((l) => l.startsWith('dump='))!.slice(5);
    expect(fs.readFileSync(dumpPath).equals(dump)).toBe(true);
    expect(out).toContain('objects=2');
    // A partial file from an interrupted run does not get in the way.
    fs.writeFileSync(`${dumpPath}.partial`, 'left over');
    out.length = 0;
    expect(
      await runCli(
        ['fetch-mirror', '--key-file', keyFile, '--passphrase-stdin', '--out', outDir, ...confirm],
        io,
      ),
    ).toBe(0);

    out.length = 0;
    expect(
      await runCli(
        ['put-mirror-objects', '--key-file', keyFile, '--passphrase-stdin', '--run', newest],
        io,
      ),
    ).toBe(0);
    expect(out).toContain('objects=2');
    expect(local.objects.get('items/x/a.tif')!.body.toString()).toBe('TIFFDATA');
    expect(local.objects.get('items/x/a.tif')!.contentType).toBe('image/tiff');
  });

  describe('signed mirror runs at restore', () => {
    let keyFile: string;
    let local: FakeS3;
    let out: string[];
    let errs: string[];
    let newest: string;
    const io = (): CliIo => ({
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      stdin: async () => `${KEY_PASS}\n`,
      env: (n) => process.env[n],
      readFile: async (p) => fs.readFileSync(p),
      offsite: () => remote,
      local: () => ({ s3: local, bucket: 'gratisgis' }),
    });
    const withKey = (...a: string[]) => [...a, '--key-file', keyFile, '--passphrase-stdin'];
    const put = () =>
      runCli(
        ['put-mirror-objects', ...withKey('--run', newest, '--work', path.join(dir, 'w'))],
        io(),
      );

    beforeEach(async () => {
      await sourcePut('items/x/a.tif', 'TIFFDATA', 'image/tiff');
      await sourcePut('items/y/b.json', '{}', 'application/json');
      await upload(
        addRun('ffffffff-0000-4000-8000-00000000000f', new Date(Date.now() - 2 * DAY)).id as string,
      );
      const r2 = await upload(
        addRun('f0f0f0f0-0000-4000-8000-000000000010', new Date(Date.now() - DAY)).id as string,
      );
      newest = mirrorRunId(String(r2.filename), String(r2.id), r2.startedAt as Date);
      keyFile = path.join(dir, 'k.ggkey');
      fs.writeFileSync(
        keyFile,
        await sealKeyFile(key, KEY_PASS, {
          logN: 14,
          verifyKeys: [String(configRow.offsiteVerifyKey)],
        }),
      );
      local = new FakeS3();
      out = [];
      errs = [];
    });

    it('the done marker is signed and names the checksum of every object', async () => {
      expect(await runCli(['describe', ...withKey()], io())).toBe(0);
      expect(out).toContain(`name=${newest}`);
      expect(out).toContain('signature=verified');
      expect(await put()).toBe(0);
      expect(fs.readdirSync(path.join(dir, 'w'))).toEqual([]);
    });

    it('refuses a changed file index before decrypting it, and puts nothing back', async () => {
      const k = `${PREFIX}mirror/runs/${newest}/objects.jsonl.enc`;
      const body = Buffer.from(remote.objects.get(k)!.body);
      body[150]! ^= 1;
      remote.objects.get(k)!.body = body;
      expect(await put()).toBe(1);
      expect(errs.join(' ')).toMatch(/does not match the checksum in its signed record/);
      expect(local.objects.size).toBe(0);
    });

    it('refuses a changed mirrored file before decrypting it', async () => {
      for (const f of files()) {
        const body = Buffer.from(remote.objects.get(f)!.body);
        body[body.length - 1]! ^= 1;
        remote.objects.get(f)!.body = body;
      }
      expect(await put()).toBe(1);
      expect(errs.join(' ')).toMatch(/does not match the checksum in its signed record/);
      expect(local.objects.size).toBe(0);
    });

    it('refuses a mirrored file replaced by one that decrypts with the same key', async () => {
      // Anyone with the public key can make a file that decrypts; the
      // signed index still names the original.
      const f = files()[0]!;
      const forged = await collect(
        sealStream(Readable.from([Buffer.from('FORGED')]), key.publicKey),
      );
      remote.objects.get(f)!.body = forged;
      expect(await put()).toBe(1);
      expect(errs.join(' ')).toMatch(/signed record/);
    });

    it('refuses a done marker taken from another run, even with the flag', async () => {
      const runsPrefix = `${PREFIX}mirror/runs/`;
      const other = [...remote.objects.keys()]
        .filter((k) => k.startsWith(runsPrefix) && k.endsWith('/done.json'))
        .find((k) => !k.includes(newest))!;
      remote.objects.get(`${runsPrefix}${newest}/done.json`)!.body =
        remote.objects.get(other)!.body;
      expect(
        await runCli(
          [
            'describe',
            ...withKey(
              '--run',
              newest,
              '--allow-foreign-install',
              '--allow-untrusted-signer',
              '--allow-unsigned-copy',
            ),
          ],
          io(),
        ),
      ).toBe(1);
      expect(errs.join(' ')).toMatch(/the run does not match/);
      expect(await put()).toBe(1);
      expect(local.objects.size).toBe(0);
    });

    it('a changed dump is refused before it is decrypted', async () => {
      const k = `${PREFIX}mirror/runs/${newest}/database.dump.enc`;
      const body = Buffer.from(remote.objects.get(k)!.body);
      body[500]! ^= 1;
      remote.objects.get(k)!.body = body;
      const outDir = path.join(dir, 'restore');
      expect(
        await runCli(['fetch-mirror', ...withKey('--out', outDir, '--confirm-copy', newest)], io()),
      ).toBe(1);
      expect(errs.join(' ')).toMatch(/signed record/);
      expect(fs.readdirSync(path.join(outDir, newest))).toEqual([]);
    });
  });

  describe('retention and signatures', () => {
    it('sets a badly signed run aside, never deletes it, and reports it', async () => {
      await sourcePut('keep.txt', 'keep', 'text/plain');
      const r = await upload(
        addRun('15151515-0000-4000-8000-000000000015', new Date(Date.now() - 40 * DAY))
          .id as string,
      );
      const runId = mirrorRunId(String(r.filename), String(r.id), r.startedAt as Date);
      const doneKey = `${PREFIX}mirror/runs/${runId}/done.json`;
      // A newer run planted with a signature by another key.
      const planted = '2026-11-23T02-00-00-000-16161616';
      const j = JSON.parse(remote.objects.get(doneKey)!.body.toString()) as {
        signature: { manifest: string };
      };
      const forged = { ...j, signature: { ...j.signature, value: 'A'.repeat(86) } };
      remote.objects.set(`${PREFIX}mirror/runs/${planted}/done.json`, {
        body: Buffer.from(JSON.stringify(forged)),
        lastModified: new Date(),
        etag: '"d"',
      });
      const notice = (svc as unknown as { notice: { announceOffsite: jest.Mock } }).notice;
      const before = files();
      await svc.enforceRetention(await svc.settings(), remote);
      // The 40-day-old signed run is still the newest good one.
      expect(remote.objects.has(doneKey)).toBe(true);
      expect(files()).toEqual(before);
      expect(remote.objects.has(`${PREFIX}mirror/runs/${planted}/done.json`)).toBe(true);
      expect(notice.announceOffsite).toHaveBeenCalledTimes(1);
      expect(notice.announceOffsite).toHaveBeenCalledWith(
        expect.stringMatching(/^set-aside:[0-9a-f]{32}$/),
        {
          kind: 'offsite_set_aside',
          count: 1,
          badSignature: 1,
          dated: 0,
          name: `mirror:${planted}`,
        },
      );
    });
  });

  describe('restore and retention checks', () => {
    let keyFile: string;
    let local: FakeS3;
    let out: string[];
    let errs: string[];
    const ALL = ['--allow-foreign-install', '--allow-untrusted-signer', '--allow-unsigned-copy'];
    const io = (): CliIo => ({
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      stdin: async () => `${KEY_PASS}\n`,
      env: (n) => process.env[n],
      readFile: async (p) => fs.readFileSync(p),
      offsite: () => remote,
      local: () => ({ s3: local, bucket: 'gratisgis' }),
    });
    const withKey = (...a: string[]) => [...a, '--key-file', keyFile, '--passphrase-stdin'];
    const cli = async (...a: string[]) => {
      out = [];
      errs = [];
      return runCli(a, io());
    };
    const runIdOf = (r: Row) => mirrorRunId(String(r.filename), String(r.id), r.startedAt as Date);
    const notice = () =>
      (svc as unknown as { notice: { announceOffsite: jest.Mock } }).notice.announceOffsite;
    const deletes = () => remote.calls.filter((c) => c === 'DeleteObjectCommand').length;
    async function writeKeyFile() {
      keyFile = path.join(dir, 'k.ggkey');
      fs.writeFileSync(
        keyFile,
        await sealKeyFile(key, KEY_PASS, {
          logN: 14,
          verifyKeys: [String(configRow.offsiteVerifyKey)],
        }),
      );
    }
    /** Make every mirrored file the bucket holds look `days` old. */
    function age(days: number) {
      for (const f of files())
        remote.objects.get(f)!.lastModified = new Date(Date.now() - days * DAY);
    }

    beforeEach(async () => {
      local = new FakeS3();
      out = [];
      errs = [];
      await sourcePut('items/x/a.tif', 'TIFFDATA', 'image/tiff');
      await sourcePut('items/y/b.json', '{}', 'application/json');
    });

    it('after the local index is lost, a new run never changes what an earlier signed run refers to', async () => {
      const r1 = await upload(
        addRun('31313131-0000-4000-8000-000000000031', new Date(Date.now() - 2 * DAY)).id as string,
      );
      const before = new Map(files().map((k) => [k, Buffer.from(remote.objects.get(k)!.body)]));
      // The index is emptied, as a restore of the portal database does.
      objects.splice(0, objects.length);
      mirrorRuns.splice(0, mirrorRuns.length);
      const r2 = await upload(
        addRun('32323232-0000-4000-8000-000000000032', new Date(Date.now() - DAY)).id as string,
      );
      expect(r2.offsiteStatus).toBe('succeeded');
      expect(doneOf(r2)).toMatchObject({ uploaded: 2, reused: 0 });
      // Uploaded again under new names; the earlier files are untouched.
      expect(files()).toHaveLength(4);
      for (const [k, b] of before) expect(remote.objects.get(k)!.body.equals(b)).toBe(true);

      // The first run still verifies and restores in full.
      await writeKeyFile();
      const run1 = runIdOf(r1);
      expect(await cli('describe', ...withKey('--run', run1))).toBe(0);
      expect(out).toContain('signature=verified');
      const outDir = path.join(dir, 'restore');
      expect(
        await cli(
          'fetch-mirror',
          ...withKey('--out', outDir, '--run', run1, '--confirm-copy', run1),
        ),
      ).toBe(0);
      expect(out).toContain('objects=2');
      expect(fs.readFileSync(path.join(outDir, run1, 'database.dump')).equals(dump)).toBe(true);
      expect(
        await cli('put-mirror-objects', ...withKey('--run', run1, '--work', path.join(dir, 'w'))),
      ).toBe(0);
      expect(local.objects.get('items/x/a.tif')!.body.toString()).toBe('TIFFDATA');
      expect(local.objects.get('items/y/b.json')!.body.toString()).toBe('{}');
    });

    it('files a lost index left behind are kept while an older run remains, then removed in bounded steps', async () => {
      process.env.BACKUP_OFFSITE_RETENTION_DAYS = '30';
      try {
        const r1 = await upload(
          addRun('33333333-0000-4000-8000-000000000033', new Date(Date.now() - 20 * DAY))
            .id as string,
        );
        const left = files();
        objects.splice(0, objects.length);
        mirrorRuns.splice(0, mirrorRuns.length);
        age(20);
        await upload(
          addRun('34343434-0000-4000-8000-000000000034', new Date(Date.now() - DAY)).id as string,
        );
        // The first run is inside the window and was not started with
        // this index: its files stay.
        for (const f of left) expect(remote.objects.has(f)).toBe(true);
        expect(remote.objects.has(`${PREFIX}mirror/runs/${runIdOf(r1)}/done.json`)).toBe(true);

        // Later the first run ages out. Every run left is this server's,
        // so the files only it named are removed, one per pass here.
        process.env.BACKUP_OFFSITE_RETENTION_DAYS = '10';
        (svc as unknown as { mirror: { maxOrphansPerPass: number } }).mirror.maxOrphansPerPass = 1;
        const s = await svc.settings();
        await svc.enforceRetention(s, remote);
        expect(remote.objects.has(`${PREFIX}mirror/runs/${runIdOf(r1)}/done.json`)).toBe(false);
        expect(left.filter((f) => remote.objects.has(f))).toHaveLength(1);
        await svc.enforceRetention(s, remote);
        expect(left.filter((f) => remote.objects.has(f))).toHaveLength(0);
        // The current run's files are in the index and stay.
        expect(files()).toHaveLength(2);
        for (const o of objects)
          expect(remote.objects.has(`${OBJECTS}${String(o.name)}`)).toBe(true);
      } finally {
        delete process.env.BACKUP_OFFSITE_RETENTION_DAYS;
      }
    });

    it('never removes an unknown file while a run folder this server did not start is in the bucket, or while it is new', async () => {
      await upload(
        addRun('35353535-0000-4000-8000-000000000035', new Date(Date.now() - DAY)).id as string,
      );
      const stray = `${OBJECTS}${'e'.repeat(64)}.enc`;
      remote.objects.set(stray, {
        body: Buffer.from('x'),
        lastModified: new Date(Date.now() - 60 * DAY),
        etag: '"s"',
      });
      const fresh = `${OBJECTS}${'d'.repeat(64)}.enc`;
      remote.objects.set(fresh, { body: Buffer.from('x'), lastModified: new Date(), etag: '"f"' });
      const other = '2026-11-01T00-00-00-000-36363636';
      remote.objects.set(`${PREFIX}mirror/runs/${other}/database.dump.enc`, {
        body: Buffer.from('partial'),
        lastModified: new Date(),
        etag: '"o"',
      });
      const s = await svc.settings();
      await svc.enforceRetention(s, remote);
      expect(remote.objects.has(stray)).toBe(true);
      expect(remote.objects.has(fresh)).toBe(true);
      // Without that folder the old one goes; the new one stays.
      remote.objects.delete(`${PREFIX}mirror/runs/${other}/database.dump.enc`);
      await svc.enforceRetention(s, remote);
      expect(remote.objects.has(stray)).toBe(false);
      expect(remote.objects.has(fresh)).toBe(true);
    });

    it('a done marker that cannot be read stops retention with nothing deleted, reported once', async () => {
      process.env.BACKUP_OFFSITE_RETENTION_DAYS = '365';
      let r2: Row;
      try {
        await upload(
          addRun('37373737-0000-4000-8000-000000000037', new Date(Date.now() - 40 * DAY))
            .id as string,
        );
        r2 = await upload(
          addRun('38383838-0000-4000-8000-000000000038', new Date(Date.now() - DAY)).id as string,
        );
      } finally {
        delete process.env.BACKUP_OFFSITE_RETENTION_DAYS;
      }
      const s = await svc.settings();
      notice().mockClear();
      for (const body of ['not json', '[1,2]', '"text"']) {
        remote.objects.get(`${PREFIX}mirror/runs/${runIdOf(r2)}/done.json`)!.body =
          Buffer.from(body);
        const before = [...remote.objects.keys()].sort();
        remote.calls.length = 0;
        expect(await svc.enforceRetention(s, remote)).toBe(0);
        expect(deletes()).toBe(0);
        expect([...remote.objects.keys()].sort()).toEqual(before);
      }
      // A read that fails is the same.
      const doneKey = `${PREFIX}mirror/runs/${runIdOf(r2)}/done.json`;
      const send = remote.send.bind(remote);
      jest
        .spyOn(remote, 'send')
        .mockImplementation(
          async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
            if (c.constructor.name === 'GetObjectCommand' && c.input.Key === doneKey) {
              throw Object.assign(new Error('fake read failure'), { name: 'InternalError' });
            }
            return send(c);
          },
        );
      remote.calls.length = 0;
      expect(await svc.enforceRetention(s, remote)).toBe(0);
      expect(deletes()).toBe(0);
      const calls = notice().mock.calls.filter(
        (c) => (c[1] as { kind: string }).kind === 'offsite_retention_stopped',
      );
      expect(calls.length).toBeGreaterThan(0);
      // One key per day, so the admins hear of it once.
      expect(new Set(calls.map((c) => c[0] as string)).size).toBe(1);
      expect(calls[0]![0]).toMatch(/^retention-stopped:\d{4}-\d{2}-\d{2}$/);
    });

    it('set-aside copies: one summary notice per pass, and at most a fixed number read', async () => {
      const r1 = await upload(
        addRun('39393939-0000-4000-8000-000000000039', new Date(Date.now() - 40 * DAY))
          .id as string,
      );
      const doneKey = `${PREFIX}mirror/runs/${runIdOf(r1)}/done.json`;
      const forged = JSON.parse(remote.objects.get(doneKey)!.body.toString()) as {
        signature: Record<string, unknown>;
      };
      forged.signature = { ...forged.signature, value: 'A'.repeat(86) };
      const plant = (id: string) =>
        remote.objects.set(`${PREFIX}mirror/runs/${id}/done.json`, {
          body: Buffer.from(JSON.stringify(forged)),
          lastModified: new Date(),
          etag: '"p"',
        });
      for (let i = 0; i < MAX_SET_ASIDE_CHECKED + 5; i += 1) {
        plant(`2026-11-2${i % 3}T00-00-00-${String(i).padStart(3, '0')}-${'0'.repeat(8)}`);
      }
      for (let i = 0; i < 3; i += 1) plant(`2099-01-0${i + 1}T00-00-00-000-${'0'.repeat(8)}`);
      const before = files();
      notice().mockClear();
      remote.calls.length = 0;
      await svc.enforceRetention(await svc.settings(), remote);
      // Older runs past the limit are not checked, so nothing is removed
      // and no file is collected.
      expect(remote.objects.has(doneKey)).toBe(true);
      expect(files()).toEqual(before);
      expect(deletes()).toBe(0);
      const reads = remote.calls.filter((c) => c === 'GetObjectCommand').length;
      // Folder marker twice, then the checked markers.
      expect(reads).toBeLessThanOrEqual(MAX_SET_ASIDE_CHECKED + 2);
      expect(notice()).toHaveBeenCalledTimes(1);
      const [key1, payload] = notice().mock.calls[0]! as [string, Record<string, unknown>];
      expect(payload).toMatchObject({
        kind: 'offsite_set_aside',
        count: MAX_SET_ASIDE_CHECKED + 3,
        badSignature: MAX_SET_ASIDE_CHECKED,
        dated: 3,
      });
      expect(String(payload.name)).toMatch(/and \d+ more$/);
      // The same set gives the same key, so it is not announced again.
      notice().mockClear();
      await svc.enforceRetention(await svc.settings(), remote);
      expect(notice().mock.calls[0]![0]).toBe(key1);
    });

    it('fetch-mirror checks every file of the run is in the bucket with its size, before the restore changes anything', async () => {
      const r = await upload(
        addRun('40404040-0000-4000-8000-000000000040', new Date(Date.now() - DAY)).id as string,
      );
      await writeKeyFile();
      const run = runIdOf(r);
      const outDir = path.join(dir, 'restore');
      const fetch = () =>
        cli('fetch-mirror', ...withKey('--out', outDir, '--run', run, '--confirm-copy', run));
      const f = files()[0]!;
      const saved = remote.objects.get(f)!;
      remote.objects.set(f, { ...saved, body: Buffer.concat([saved.body, Buffer.from('x')]) });
      expect(await fetch()).toBe(1);
      expect(errs.join(' ')).toMatch(/has \d+ bytes in the bucket; the run's index says \d+/);
      expect(out.some((l) => l.startsWith('dump='))).toBe(false);
      remote.objects.delete(f);
      expect(await fetch()).toBe(1);
      expect(errs.join(' ')).toMatch(/is not in the bucket\. Nothing was restored/);
      expect(out.some((l) => l.startsWith('dump='))).toBe(false);
      remote.objects.set(f, saved);
      expect(await fetch()).toBe(0);
      expect(out).toContain('objects=2');
    });

    it('takes the database name from the signed manifest, never from the plain done marker', async () => {
      const r = await upload(
        addRun('41414141-0000-4000-8000-000000000041', new Date(Date.now() - DAY)).id as string,
      );
      await writeKeyFile();
      const run = runIdOf(r);
      const k = `${PREFIX}mirror/runs/${run}/done.json`;
      const done = JSON.parse(remote.objects.get(k)!.body.toString()) as Record<string, unknown>;
      done.database = { name: 'other_db', sealedBytes: 1, sealedSha256: '0'.repeat(64) };
      remote.objects.get(k)!.body = Buffer.from(JSON.stringify(done));
      const outDir = path.join(dir, 'restore');
      expect(
        await cli('fetch-mirror', ...withKey('--out', outDir, '--run', run, '--confirm-copy', run)),
      ).toBe(0);
      expect(out).toContain('database=gratisgis');
    });

    describe('a run signed for another portal install', () => {
      let run: string;
      beforeEach(async () => {
        const r = await upload(
          addRun('42424242-0000-4000-8000-000000000042', new Date(Date.now() - DAY)).id as string,
        );
        run = runIdOf(r);
        await writeKeyFile();
        remote.objects.get(`${PREFIX}gratisgis-install.json`)!.body = Buffer.from(
          JSON.stringify({ installId: 'dddd2222-aaaa-4bbb-8ccc-000000000002' }),
        );
      });

      it('needs --allow-foreign-install, and no other flag admits it', async () => {
        expect(await cli('describe', ...withKey('--run', run))).toBe(3);
        expect(out).toContain('needs=foreign');
        expect(
          await cli(
            'describe',
            ...withKey('--run', run, '--allow-untrusted-signer', '--allow-unsigned-copy'),
          ),
        ).toBe(3);
        expect(await cli('describe', ...withKey('--run', run, '--allow-foreign-install'))).toBe(0);
        expect(out).toContain('signature=foreign');
        const outDir = path.join(dir, 'restore');
        expect(
          await cli(
            'fetch-mirror',
            ...withKey('--out', outDir, '--run', run, '--confirm-copy', run, ...ALL),
          ),
        ).toBe(0);
        expect(
          await cli(
            'put-mirror-objects',
            ...withKey('--run', run, '--work', path.join(dir, 'w'), ...ALL),
          ),
        ).toBe(0);
        expect(local.objects.get('items/x/a.tif')!.body.toString()).toBe('TIFFDATA');
      });

      it('is checked against its signed record, not the plain done marker', async () => {
        // The dump is replaced, and the done marker's plain checksum made to match.
        const k = `${PREFIX}mirror/runs/${run}/database.dump.enc`;
        const forged = await collect(
          sealStream(Readable.from([Buffer.from('FORGED')]), key.publicKey),
        );
        remote.objects.get(k)!.body = forged;
        const dk = `${PREFIX}mirror/runs/${run}/done.json`;
        const done = JSON.parse(remote.objects.get(dk)!.body.toString()) as Record<string, unknown>;
        done.database = {
          name: 'gratisgis',
          sealedBytes: forged.length,
          sealedSha256: createHash('sha256').update(forged).digest('hex'),
        };
        remote.objects.get(dk)!.body = Buffer.from(JSON.stringify(done));
        const outDir = path.join(dir, 'restore');
        expect(
          await cli(
            'fetch-mirror',
            ...withKey(
              '--out',
              outDir,
              '--run',
              run,
              '--confirm-copy',
              run,
              '--allow-foreign-install',
            ),
          ),
        ).toBe(1);
        expect(errs.join(' ')).toMatch(/signed record/);
        // A mirrored file replaced the same way is refused too.
        const f = files()[0]!;
        remote.objects.get(f)!.body = await collect(
          sealStream(Readable.from([Buffer.from('FORGED')]), key.publicKey),
        );
        expect(
          await cli(
            'put-mirror-objects',
            ...withKey('--run', run, '--work', path.join(dir, 'w'), '--allow-foreign-install'),
          ),
        ).toBe(1);
        expect(errs.join(' ')).toMatch(/signed record/);
      });
    });
  });
});
