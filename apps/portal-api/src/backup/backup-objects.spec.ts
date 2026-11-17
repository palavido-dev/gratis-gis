// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';

import type { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BackupRestoreService, contentTypeFromKey } from './backup-restore.service.js';
import { BackupService, MINIO_META_MEMBER, isNoSuchKey } from './backup.service.js';
import type { MaintenanceModeService } from './maintenance-mode.service.js';
import { writeTarGz, type TarEntry } from './tar-pack.js';

/**
 * Object-store side of backup and restore.
 *
 * 05-4: an object deleted while a backup runs used to fail the whole
 * backup. It is now left out and recorded.
 * 05-3: archives carried only key and bytes, so a restore put every
 * object back as application/octet-stream. The backup now records each
 * object's Content-Type and the restore sends it.
 */
describe('backup objects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-backup-objects-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function noSuchKey(): Error {
    return Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
  }

  it('skips an object deleted mid-run and records content types', async () => {
    const svc = new BackupService({} as PrismaService, new ConfigService());
    const objects: Record<string, { body: string; type: string } | null> = {
      'logo.svg': { body: '<svg/>', type: 'image/svg+xml' },
      'gone.png': null,
      'doc.pdf': { body: '%PDF', type: 'application/pdf' },
    };
    (svc as unknown as { s3: { send: jest.Mock } }).s3 = {
      send: jest.fn(async (cmd: { input: { Key: string } }) => {
        const o = objects[cmd.input.Key];
        if (!o) throw noSuchKey();
        return {
          Body: Readable.from([Buffer.from(o.body)]),
          ContentLength: o.body.length,
          ContentType: o.type,
        };
      }),
    };
    const dumpPath = join(dir, 'db.dump');
    writeFileSync(dumpPath, 'dump');
    const entries = (
      svc as unknown as {
        archiveEntries: (...a: unknown[]) => AsyncGenerator<TarEntry>;
      }
    ).archiveEntries(
      { version: 1 },
      'gratisgis.dump',
      dumpPath,
      Object.keys(objects).map((key) => ({ key, size: 1 })),
      () => {},
      new AbortController().signal,
    );
    const archive = join(dir, 'a.tar.gz');
    await writeTarGz(archive, entries);

    const out = join(dir, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-xzf', archive, '-C', out]);
    expect(readFileSync(join(out, 'minio', 'logo.svg'), 'utf8')).toBe('<svg/>');
    const meta = JSON.parse(readFileSync(join(out, MINIO_META_MEMBER), 'utf8'));
    expect(meta).toEqual({
      version: 1,
      contentTypes: { 'logo.svg': 'image/svg+xml', 'doc.pdf': 'application/pdf' },
      skipped: ['gone.png'],
    });
  });

  it('still fails on any other read error', async () => {
    expect(isNoSuchKey(noSuchKey())).toBe(true);
    expect(isNoSuchKey(Object.assign(new Error('denied'), { name: 'AccessDenied' }))).toBe(false);
  });

  it('restore puts objects back with the recorded type, or a guess for old archives', async () => {
    const stage = join(dir, 'stage');
    mkdirSync(join(stage, 'minio', 'icons'), { recursive: true });
    writeFileSync(join(stage, 'minio', 'icons', 'a.svg'), '<svg/>');
    writeFileSync(join(stage, 'minio', 'blob'), 'x');
    writeFileSync(join(stage, 'minio', 'photo.jpg'), 'x');
    writeFileSync(
      join(stage, MINIO_META_MEMBER),
      JSON.stringify({ version: 1, contentTypes: { blob: 'image/png' }, skipped: [] }),
    );
    const svc = new BackupRestoreService(
      {} as PrismaService,
      new ConfigService(),
      {} as BackupService,
      {} as MaintenanceModeService,
      {} as TileCacheService,
    );
    const puts: Record<string, string | undefined> = {};
    (svc as unknown as { s3: { send: jest.Mock } }).s3 = {
      send: jest.fn(async (cmd: { input: { Key?: string; ContentType?: string; Body?: unknown } }) => {
        if (cmd.input.Body !== undefined && cmd.input.Key) {
          // Drain it, as the real client does, so no file handle is
          // still opening when the temp dir is removed.
          await (cmd.input.Body as Readable).toArray();
          puts[cmd.input.Key] = cmd.input.ContentType;
        }
        return { Contents: [], IsTruncated: false };
      }),
    };
    const s = svc as unknown as {
      readStagedContentTypes: (d: string) => Promise<Record<string, string>>;
      restoreMinio: (d: string, t: Record<string, string>) => Promise<void>;
    };
    await s.restoreMinio(join(stage, 'minio'), await s.readStagedContentTypes(stage));
    expect(puts).toEqual({
      'icons/a.svg': 'image/svg+xml',
      blob: 'image/png',
      'photo.jpg': 'image/jpeg',
    });
  });

  it('guesses types from extensions', () => {
    expect(contentTypeFromKey('a/b/C.PNG')).toBe('image/png');
    expect(contentTypeFromKey('noext')).toBeUndefined();
  });
});
