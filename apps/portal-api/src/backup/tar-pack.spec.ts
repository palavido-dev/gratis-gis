// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { writeTarGz, type TarEntry } from './tar-pack.js';
import { extractTarGz, readTarEntry } from './tar-cli.js';

/**
 * The point of these tests is compatibility, not coverage.
 *
 * The write path now packs in process; the READ path is still the
 * system tar binary (tar-cli.extractTarGz / readTarEntry), and
 * backup-restore.service.ts depends on it. So every test here writes
 * with tar-stream and reads back with the actual `tar` binary. If the
 * two ever disagree, this suite fails rather than a restore failing on
 * the day someone needs it, which is the only day anyone finds out.
 */
describe('writeTarGz', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-tarpack-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function* entries(list: TarEntry[]): AsyncGenerator<TarEntry> {
    for (const e of list) yield e;
  }

  it('produces an archive the system tar can read, with the v1 layout', async () => {
    const archive = path.join(dir, 'out.tar.gz');
    const dumpBytes = randomBytes(4096);
    const dumpFile = path.join(dir, 'src.dump');
    await fs.writeFile(dumpFile, dumpBytes);

    const manifest = { version: 1, databases: ['gratisgis'] };
    await writeTarGz(
      archive,
      entries([
        {
          kind: 'buffer',
          name: 'manifest.json',
          body: Buffer.from(JSON.stringify(manifest), 'utf8'),
        },
        {
          kind: 'stream',
          name: 'postgres/gratisgis.dump',
          size: dumpBytes.length,
          open: () => createReadStream(dumpFile),
        },
        {
          kind: 'stream',
          name: 'minio/item-file/abc.bin',
          size: 3,
          open: () => Readable.from([Buffer.from('abc')]),
        },
      ]),
    );

    // Read back with the real binary, the way restore does.
    const out = path.join(dir, 'x');
    await fs.mkdir(out);
    await extractTarGz(archive, out);

    expect(
      JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8')),
    ).toEqual(manifest);
    expect(await fs.readFile(path.join(out, 'postgres/gratisgis.dump'))).toEqual(
      dumpBytes,
    );
    // Object keys must survive as relative paths under minio/, because
    // restoreMinio reconstructs the key by joining them back together.
    expect(
      await fs.readFile(path.join(out, 'minio/item-file/abc.bin'), 'utf8'),
    ).toBe('abc');
  });

  it('lets readTarEntry find the manifest without extracting', async () => {
    // peekArchive's cheap path. Manifest is written FIRST now; this
    // pins that the binary still locates it by name either way.
    const archive = path.join(dir, 'out.tar.gz');
    await writeTarGz(
      archive,
      entries([
        {
          kind: 'buffer',
          name: 'manifest.json',
          body: Buffer.from('{"version":1}', 'utf8'),
        },
        {
          kind: 'stream',
          name: 'minio/z.bin',
          size: 5,
          open: () => Readable.from([Buffer.from('zzzzz')]),
        },
      ]),
    );
    const buf = await readTarEntry(archive, 'manifest.json');
    expect(buf).not.toBeNull();
    expect(JSON.parse(buf!.toString('utf8'))).toEqual({ version: 1 });
  });

  it('refuses to seal when a body is shorter than its declared size', async () => {
    // THE failure mode of a streaming writer. A tar member header
    // commits to a length before the bytes, and the portal keeps
    // serving during a backup, so an object can change between the
    // listing and the GET. Silently accepting that corrupts the
    // archive from this member onward and nothing notices until a
    // restore. Fail loudly, naming the key.
    const archive = path.join(dir, 'out.tar.gz');
    await expect(
      writeTarGz(
        archive,
        entries([
          {
            kind: 'stream',
            name: 'minio/short.bin',
            size: 100,
            open: () => Readable.from([Buffer.from('only-ten!!')]),
          },
        ]),
      ),
    ).rejects.toThrow(/short\.bin.*100.*delivered 10/s);
  });

  it('refuses when a body is longer than its declared size', async () => {
    const archive = path.join(dir, 'out.tar.gz');
    await expect(
      writeTarGz(
        archive,
        entries([
          {
            kind: 'stream',
            name: 'minio/long.bin',
            size: 2,
            open: () => Readable.from([Buffer.from('much longer')]),
          },
        ]),
      ),
    ).rejects.toThrow(/long\.bin/);
  });

  it('propagates a producer failure instead of hanging', async () => {
    // If the S3 GET throws mid-archive the whole run must reject. An
    // earlier shape of this could leave the sink promise unsettled and
    // the backup would hang until the container was killed, which is
    // how orphan stage dirs are made.
    const archive = path.join(dir, 'out.tar.gz');
    async function* boom(): AsyncGenerator<TarEntry> {
      yield {
        kind: 'buffer',
        name: 'manifest.json',
        body: Buffer.from('{}', 'utf8'),
      };
      throw new Error('S3 exploded');
    }
    await expect(writeTarGz(archive, boom())).rejects.toThrow('S3 exploded');
  });

  it('streams a payload larger than any buffer it could hold', async () => {
    // Backpressure check. 24 MB through a 64 KB-chunked source: if the
    // pack/gzip/file chain were not piped with backpressure this would
    // balloon in RSS rather than flow.
    const archive = path.join(dir, 'out.tar.gz');
    const CHUNK = 64 * 1024;
    const COUNT = 384;
    const chunk = Buffer.alloc(CHUNK, 7);
    await writeTarGz(
      archive,
      entries([
        {
          kind: 'stream',
          name: 'minio/big.bin',
          size: CHUNK * COUNT,
          open: () =>
            Readable.from(
              (function* () {
                for (let i = 0; i < COUNT; i += 1) yield chunk;
              })(),
            ),
        },
      ]),
    );
    const out = path.join(dir, 'x');
    await fs.mkdir(out);
    await extractTarGz(archive, out);
    const st = await fs.stat(path.join(out, 'minio/big.bin'));
    expect(st.size).toBe(CHUNK * COUNT);
  });
});
