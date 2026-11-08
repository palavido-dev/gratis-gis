// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';

import {
  containedPayloadFile,
  discardDiskUpload,
  payloadFileName,
  pinDiskUpload,
  serverUploadName,
  takeContainedDiskUpload,
} from './ingest-disk-path.js';

describe('server upload names', () => {
  it('never keeps a path segment from the request', () => {
    expect(serverUploadName('..')).toBe('payload.bin');
    expect(serverUploadName('../..')).toBe('payload.bin');
    expect(serverUploadName('../../etc/passwd')).toBe('payload.bin');
    expect(serverUploadName('/etc/passwd')).toBe('payload.bin');
    // A dotfile whose suffix matches a known extension still stores the
    // constant `payload.geojson`, not the request string.
    expect(serverUploadName('..geojson')).toBe('payload.geojson');
    for (const name of ['..', '../..', '../../etc/passwd', '/etc/passwd', 'roads.geojson']) {
      const stored = serverUploadName(name);
      expect(stored.includes('..')).toBe(false);
      expect(stored.includes('/')).toBe(false);
      expect(payloadFileName(stored)).toBe(stored);
    }
    expect(serverUploadName('roads.geojson')).toBe('payload.geojson');
    expect(serverUploadName('ROADS.ZIP')).toBe('payload.zip');
    expect(serverUploadName('layer.gdb.zip')).toBe('payload.zip');
    expect(serverUploadName('notes.evil')).toBe('payload.bin');
    expect(payloadFileName(serverUploadName('..'))).toBe('payload.bin');
    expect(payloadFileName('../payload.geojson')).toBeNull();
  });
});

describe('contained disk upload', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function ingestDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gg-ingest-'));
    dirs.push(realpathSync(dir));
    return dir;
  }

  it('opens the server-chosen file and rejects a path that leaves the directory', () => {
    const dir = ingestDir();
    const file = join(dir, 'payload.geojson');
    writeFileSync(file, '{}');
    const req = {};
    pinDiskUpload(req, dir, file);
    const taken = takeContainedDiskUpload(req);
    expect(taken.filePath).toBe(realpathSync(file));
    expect(taken.directory).toBe(realpathSync(dir));

    expect(() => containedPayloadFile(join(dir, '..'))).toThrow(BadRequestException);
    expect(() => containedPayloadFile(join(dir, '..', '..', 'etc', 'passwd'))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a symlink that points outside the upload directory', () => {
    const dir = ingestDir();
    const outside = mkdtempSync(join(tmpdir(), 'gg-outside-'));
    dirs.push(realpathSync(outside));
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(dir, 'payload.geojson'));
    expect(() => containedPayloadFile(join(dir, 'payload.geojson'))).toThrow(
      BadRequestException,
    );
    expect(existsSync(secret)).toBe(true);
  });

  it('does not delete a directory that is not an ingest temp dir', async () => {
    const other = mkdtempSync(join(tmpdir(), 'gg-other-'));
    dirs.push(realpathSync(other));
    writeFileSync(join(other, 'keep.txt'), 'keep');
    const req = {};
    pinDiskUpload(req, other, join(other, 'keep.txt'));
    await discardDiskUpload(req);
    expect(existsSync(join(other, 'keep.txt'))).toBe(true);
  });

  it('deletes an ingest temp dir it created', async () => {
    const dir = ingestDir();
    writeFileSync(join(dir, 'payload.bin'), 'x');
    const req = {};
    pinDiskUpload(req, dir, join(dir, 'payload.bin'));
    await discardDiskUpload(req);
    expect(existsSync(dir)).toBe(false);
  });
});
