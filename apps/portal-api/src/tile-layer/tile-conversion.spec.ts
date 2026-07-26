// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  MAX_ZIP_ENTRIES,
  extractZipToDir,
} from './tile-conversion.js';

/**
 * Minimal zip writer for the extractor's spec. Hand-rolled on
 * purpose: the overrides (lying sizes, bad CRCs, symlink modes,
 * zip64 sentinels) are exactly the shapes a well-behaved zip
 * library refuses to produce, and they are the shapes the
 * extractor exists to reject.
 */
interface BuildEntry {
  name: string;
  /** Omitted = directory entry (name should end with '/'). */
  data?: Buffer | string;
  method?: 0 | 8;
  flags?: number;
  externalAttrs?: number;
  /** Lie about the inflated size in the central directory. */
  uncompressedSizeOverride?: number;
  /** Lie about the CRC in the central directory. */
  crcOverride?: number;
  /** Route sizes/offset through a zip64 extra field. */
  zip64?: boolean;
}

const FILE_ATTRS = (0o100644 << 16) >>> 0;
const DIR_ATTRS = ((0o40755 << 16) >>> 0) | 0x10;
const SYMLINK_ATTRS = (0o120777 << 16) >>> 0;

function buildZip64Extra(
  usize: number,
  csize: number,
  offset: number,
): Buffer {
  const b = Buffer.alloc(4 + 24);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(24, 2);
  b.writeBigUInt64LE(BigInt(usize), 4);
  b.writeBigUInt64LE(BigInt(csize), 12);
  b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

function buildZip(
  entries: BuildEntry[],
  opts: { zip64EntryCount?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const isDir = e.data === undefined;
    const data = isDir
      ? Buffer.alloc(0)
      : typeof e.data === 'string'
        ? Buffer.from(e.data)
        : (e.data as Buffer);
    const method = e.method ?? (isDir || data.length === 0 ? 0 : 8);
    const stored = method === 0 ? data : deflateRawSync(data);
    const crc = e.crcOverride ?? crc32(data) >>> 0;
    const usize = e.uncompressedSizeOverride ?? data.length;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const flags = e.flags ?? 0;
    const zip64 = e.zip64 === true;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(Math.min(usize, 0xffffffff), 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, stored);

    const extra = zip64
      ? buildZip64Extra(usize, stored.length, offset)
      : Buffer.alloc(0);
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(0x031e, 4); // version made by: unix
    ce.writeUInt16LE(zip64 ? 45 : 20, 6);
    ce.writeUInt16LE(flags, 8);
    ce.writeUInt16LE(method, 10);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(zip64 ? 0xffffffff : stored.length, 20);
    ce.writeUInt32LE(zip64 ? 0xffffffff : Math.min(usize, 0xffffffff), 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(extra.length, 30);
    ce.writeUInt32LE(
      e.externalAttrs ?? (isDir ? DIR_ATTRS : FILE_ATTRS),
      38,
    );
    ce.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(ce, nameBuf, extra);

    offset += lh.length + nameBuf.length + stored.length;
  }
  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);

  if (opts.zip64EntryCount !== undefined) {
    // 16-bit EOCD fields cannot express the claimed count, which
    // is the whole point: sentinel out to a zip64 record.
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeBigUInt64LE(BigInt(opts.zip64EntryCount), 24);
    eocd64.writeBigUInt64LE(BigInt(opts.zip64EntryCount), 32);
    eocd64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    eocd64.writeBigUInt64LE(BigInt(localBuf.length), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(localBuf.length + cdBuf.length), 8);
    locator.writeUInt32LE(1, 16);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, cdBuf, eocd64, locator, eocd]);
  }

  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

describe('extractZipToDir', () => {
  let workRoot: string;
  let zipPath: string;
  let destDir: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'zip-spec-'));
    zipPath = join(workRoot, 'in.zip');
    destDir = join(workRoot, 'out');
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  async function writeZip(
    entries: BuildEntry[],
    opts: { zip64EntryCount?: number } = {},
  ): Promise<void> {
    await writeFile(zipPath, buildZip(entries, opts));
  }

  it('extracts stored, deflated, empty, and nested entries', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await writeZip([
      { name: '0/', },
      { name: '0/0/', },
      { name: '0/0/0.png', data: png, method: 8 },
      { name: 'metadata.json', data: '{"format":"png"}', method: 0 },
      { name: 'empty.txt', data: '' },
    ]);
    await extractZipToDir(zipPath, destDir);
    expect(await readFile(join(destDir, '0/0/0.png'))).toEqual(png);
    expect(
      (await readFile(join(destDir, 'metadata.json'))).toString(),
    ).toBe('{"format":"png"}');
    expect((await readFile(join(destDir, 'empty.txt'))).length).toBe(0);
  });

  it('creates missing parent directories for entries without dir records', async () => {
    await writeZip([{ name: 'deep/tree/tile.pbf', data: 'vector-bytes' }]);
    await extractZipToDir(zipPath, destDir);
    expect(
      (await readFile(join(destDir, 'deep/tree/tile.pbf'))).toString(),
    ).toBe('vector-bytes');
  });

  it('handles zip64 extra fields for sizes and offsets', async () => {
    await writeZip([
      { name: 'big-ish.bin', data: 'zip64-routed contents', zip64: true },
    ]);
    await extractZipToDir(zipPath, destDir);
    expect(
      (await readFile(join(destDir, 'big-ish.bin'))).toString(),
    ).toBe('zip64-routed contents');
  });

  it('rejects .. traversal and writes nothing outside the target', async () => {
    await writeZip([{ name: '../evil.txt', data: 'pwned' }]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /escapes the extraction directory/,
    );
    // The would-be escape target must not exist.
    await expect(access(join(dirname(destDir), 'evil.txt'))).rejects.toThrow();
  });

  it('rejects backslash-separated traversal', async () => {
    await writeZip([{ name: '..\\evil.txt', data: 'pwned' }]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /escapes the extraction directory/,
    );
  });

  it('rejects an absolute entry path', async () => {
    await writeZip([{ name: '/etc/cron.d/x', data: 'pwned' }]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /absolute path/,
    );
  });

  it('rejects a symlink member outright', async () => {
    // A symlink is how a crafted archive gets an extractor to
    // write outside the target on a later entry; refuse it.
    await writeZip([
      { name: 'link', data: '/etc/passwd', externalAttrs: SYMLINK_ATTRS },
    ]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /symlink/,
    );
  });

  it('rejects an entry that lies about its inflated size (zip bomb)', async () => {
    // Central directory claims one byte; the deflate stream
    // inflates to far more. The inflate counter must trip before
    // the oversize output lands.
    const big = Buffer.alloc(4096, 0x41);
    await writeZip([
      { name: 'bomb.bin', data: big, method: 8, uncompressedSizeOverride: 1 },
    ]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /inflated past its declared size/,
    );
  });

  it('rejects an entry whose CRC does not match', async () => {
    await writeZip([
      { name: 'corrupt.png', data: 'real-bytes', crcOverride: 0xdeadbeef },
    ]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /CRC mismatch/,
    );
  });

  it('rejects an encrypted entry', async () => {
    await writeZip([{ name: 'secret.png', data: 'x', flags: 0x0001 }]);
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /encrypted/,
    );
  });

  it('refuses an archive whose declared entry count is past the ceiling', async () => {
    // A single real entry, but the zip64 record claims a count
    // over MAX_ZIP_ENTRIES. The header is refused before the walk.
    await writeZip([{ name: '0/0/0.png', data: 'tile' }], {
      zip64EntryCount: MAX_ZIP_ENTRIES + 1,
    });
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /entry ceiling/,
    );
  });

  it('rejects a non-zip file', async () => {
    await writeFile(zipPath, Buffer.from('this is definitely not a zip file'));
    await expect(extractZipToDir(zipPath, destDir)).rejects.toThrow(
      /Not a zip file/,
    );
  });
});