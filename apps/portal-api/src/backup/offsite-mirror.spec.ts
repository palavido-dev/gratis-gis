// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { FakeS3 } from '../testing/fake-s3.js';
import { emptyConfigRow, makePrisma, type Row } from '../testing/offsite-fixtures.js';
import type { BackupService } from './backup.service.js';
import { runCli, type CliIo } from './offsite-cli.js';
import { unsealStream } from './offsite-crypto.js';
import { mirrorObjectName, mirrorRunId } from './offsite-mirror.js';
import { OffsiteService } from './offsite.service.js';

const PASS = 'mirror test passphrase 0123';
const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

async function collect(it: AsyncIterable<unknown>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(Buffer.from(b as Buffer));
  return Buffer.concat(out);
}

function stamp(d: Date) {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

describe('mirrorObjectName', () => {
  it('is stable, hides the key, and changes when the file changes', () => {
    const a = mirrorObjectName('items/a/photo.jpg', 10, '"e1"');
    expect(a).toBe(mirrorObjectName('items/a/photo.jpg', 10, '"e1"'));
    expect(a).toMatch(/^[0-9a-f]{64}\.enc$/);
    expect(mirrorObjectName('items/a/photo.jpg', 10, '"e2"')).not.toBe(a);
    expect(mirrorObjectName('items/a/photo.jpg', 11, '"e1"')).not.toBe(a);
  });
});

describe('off-site mirror mode', () => {
  const ENV = {
    BACKUP_OFFSITE_ENABLED: 'true',
    BACKUP_OFFSITE_ENDPOINT: 'https://s3.example.test',
    BACKUP_OFFSITE_BUCKET: 'offsite-bucket',
    BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'mirror-secret-value-1',
    BACKUP_OFFSITE_PASSPHRASE: PASS,
  };
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let remote: FakeS3;
  let source: FakeS3;
  let runs: Row[];
  let svc: OffsiteService;
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
  }

  async function upload(id: string) {
    const pending: unknown = await svc.startUpload(id, 100 * GB);
    if (pending instanceof Promise) await pending;
  }

  async function sourcePut(key: string, body: string, type: string) {
    await source.send({
      constructor: { name: 'PutObjectCommand' },
      input: { Bucket: 'gratisgis', Key: key, Body: Buffer.from(body), ContentType: type },
    } as never);
  }

  beforeEach(() => {
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-mirror-'));
    remote = new FakeS3();
    source = new FakeS3();
    runs = [];
    const backup = {
      configRow: jest.fn(async () => emptyConfigRow()),
      getConfig: jest.fn(async () => ({ archiveDirectory: dir })),
      onRunSucceeded: jest.fn(),
      sourceStore: () => ({ s3: source, bucket: 'gratisgis' }),
    } as unknown as BackupService;
    svc = new OffsiteService(makePrisma(runs, emptyConfigRow()) as never, backup, {
      announceOffsite: jest.fn(),
    } as never);
    svc.clientFactory = () => remote;
    svc.sealCost = 14;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uploads only new or changed files, says which mode ran, and hides file names', async () => {
    await sourcePut('items/a/photo.jpg', 'AAAA', 'image/jpeg');
    await sourcePut('items/b/data.json', '{"v":1}', 'application/json');
    addRun('11111111-0000-4000-8000-000000000001', new Date(Date.now() - 2 * DAY));
    await upload('11111111-0000-4000-8000-000000000001');
    expect(runs[0]).toMatchObject({ offsiteStatus: 'succeeded', offsiteMode: 'mirror' });

    const objectKeys = [...remote.objects.keys()].filter((k) =>
      k.startsWith('gratisgis/mirror/objects/'),
    );
    expect(objectKeys).toHaveLength(2);
    for (const k of remote.objects.keys()) {
      expect(k).not.toContain('photo.jpg');
      expect(k).not.toContain('data.json');
    }
    const runId = mirrorRunId(
      String(runs[0]!.filename),
      String(runs[0]!.id),
      runs[0]!.startedAt as Date,
    );
    const done = JSON.parse(
      remote.objects.get(`gratisgis/mirror/runs/${runId}/done.json`)!.body.toString(),
    ) as {
      uploaded: number;
      reused: number;
    };
    expect(done).toMatchObject({ uploaded: 2, reused: 0 });
    const sealedDump = remote.objects.get(`gratisgis/mirror/runs/${runId}/database.dump.enc`)!.body;
    expect((await collect(unsealStream(Readable.from([sealedDump]), PASS))).equals(dump)).toBe(
      true,
    );

    // Second run: one changed, one new, one unchanged, none deleted yet.
    await sourcePut('items/b/data.json', '{"v":2}', 'application/json');
    await sourcePut('items/c/new.txt', 'new', 'text/plain');
    addRun('22222222-0000-4000-8000-000000000002', new Date(Date.now() - DAY));
    await upload('22222222-0000-4000-8000-000000000002');
    const runId2 = mirrorRunId(
      String(runs[1]!.filename),
      String(runs[1]!.id),
      runs[1]!.startedAt as Date,
    );
    const done2 = JSON.parse(
      remote.objects.get(`gratisgis/mirror/runs/${runId2}/done.json`)!.body.toString(),
    ) as {
      uploaded: number;
      reused: number;
    };
    expect(done2).toMatchObject({ uploaded: 2, reused: 1 });
    // The old version of data.json stays for the older run.
    expect(
      [...remote.objects.keys()].filter((k) => k.startsWith('gratisgis/mirror/objects/')),
    ).toHaveLength(4);
  });

  it('retention drops old runs and files only they referred to, after the grace period', async () => {
    await sourcePut('keep.txt', 'keep', 'text/plain');
    await sourcePut('gone.txt', 'gone', 'text/plain');
    addRun('33333333-0000-4000-8000-000000000003', new Date(Date.now() - 40 * DAY));
    await upload('33333333-0000-4000-8000-000000000003');
    source.objects.delete('gone.txt');
    addRun('44444444-0000-4000-8000-000000000004', new Date(Date.now() - DAY));
    await upload('44444444-0000-4000-8000-000000000004');

    // Age every stored file past the grace period, then sweep.
    for (const o of remote.objects.values()) o.lastModified = new Date(Date.now() - 10 * DAY);
    const s = await svc.settings();
    await svc.enforceRetention(s, remote);

    const runFolders = new Set(
      [...remote.objects.keys()]
        .filter((k) => k.startsWith('gratisgis/mirror/runs/'))
        .map((k) => k.split('/')[3]),
    );
    expect(runFolders.size).toBe(1);
    const files = [...remote.objects.keys()].filter((k) =>
      k.startsWith('gratisgis/mirror/objects/'),
    );
    expect(files).toHaveLength(1);
  });

  it('the CLI restores a mirror run: dump to disk, files back into the local store', async () => {
    await sourcePut('items/x/a.tif', 'TIFFDATA', 'image/tiff');
    await sourcePut('items/y/b.json', '{}', 'application/json');
    addRun('55555555-0000-4000-8000-000000000005', new Date(Date.now() - DAY));
    await upload('55555555-0000-4000-8000-000000000005');

    const local = new FakeS3();
    const out: string[] = [];
    const io: CliIo = {
      out: (l) => out.push(l),
      err: () => undefined,
      stdin: async () => `${PASS}\n`,
      env: (n) => process.env[n],
      offsite: () => remote,
      local: () => ({ s3: local, bucket: 'gratisgis' }),
    };
    const outDir = path.join(dir, 'restore');
    expect(await runCli(['fetch-mirror', '--passphrase-stdin', '--out', outDir], io)).toBe(0);
    const dumpPath = out.find((l) => l.startsWith('dump='))!.slice(5);
    expect(fs.readFileSync(dumpPath).equals(dump)).toBe(true);
    expect(out).toContain('database=gratisgis');
    expect(out).toContain('objects=2');

    out.length = 0;
    expect(await runCli(['put-mirror-objects', '--passphrase-stdin'], io)).toBe(0);
    expect(out).toContain('objects=2');
    expect(local.objects.get('items/x/a.tif')!.body.toString()).toBe('TIFFDATA');
    expect(local.objects.get('items/x/a.tif')!.contentType).toBe('image/tiff');
  });
});
