// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  newSealKey,
  SEAL_HEADER_LEN,
  SEAL_TAG_LEN,
  SealKeyCache,
  sealedSize,
  sealStream,
  unsealStream,
} from './offsite-crypto.js';

const PASS = 'correct horse battery staple';
const CHUNK = 1024 * 1024;
const SEAL_MJS = path.resolve(__dirname, '../../../../infra/recovery/seal.mjs');

async function* pieces(buf: Buffer, step = 100_000): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
}

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(b);
  return Buffer.concat(out);
}

describe('off-site encryption (GRCV2 stream)', () => {
  // The lowest cost seal.mjs accepts, to keep the suite quick.
  let key: Awaited<ReturnType<typeof newSealKey>>;
  beforeAll(async () => {
    key = await newSealKey(PASS, { logN: 14 });
  });

  it.each([0, 1, 1000, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 5])(
    'round-trips %i bytes and matches the predicted size',
    async (n) => {
      const plain = randomBytes(n);
      const sealed = await collect(sealStream(pieces(plain), key));
      expect(sealed.length).toBe(sealedSize(n));
      expect(sealed.subarray(0, 6).toString()).toBe('GRCV2\n');
      const back = await collect(unsealStream(pieces(sealed, 77_777), PASS));
      expect(back.equals(plain)).toBe(true);
    },
  );

  it('does not contain the plaintext', async () => {
    const plain = Buffer.from('PGDMP CREATE TABLE organization '.repeat(200));
    const sealed = await collect(sealStream(pieces(plain), key));
    expect(sealed.includes(Buffer.from('CREATE TABLE'))).toBe(false);
    expect(sealed.includes(Buffer.from('PGDMP'))).toBe(false);
  });

  it('uses a fresh IV for every file under the same key', async () => {
    const a = await collect(sealStream(pieces(Buffer.from('same')), key));
    const b = await collect(sealStream(pieces(Buffer.from('same')), key));
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a wrong passphrase', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('hello')), key));
    await expect(
      collect(unsealStream(pieces(sealed), 'not the passphrase at all')),
    ).rejects.toThrow(/did not verify/);
  });

  it('rejects a changed byte anywhere', async () => {
    const plain = randomBytes(CHUNK + 10);
    const sealed = await collect(sealStream(pieces(plain), key));
    for (const at of [SEAL_HEADER_LEN - 1, SEAL_HEADER_LEN + 5, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = bad[at]! ^ 0x01;
      await expect(collect(unsealStream(pieces(bad), PASS))).rejects.toThrow();
    }
  });

  it('rejects a file cut mid-record, at a record boundary, or inside the header', async () => {
    const plain = randomBytes(2 * CHUNK + 100);
    const sealed = await collect(sealStream(pieces(plain), key));
    const boundary = SEAL_HEADER_LEN + (CHUNK + SEAL_TAG_LEN);
    for (const len of [
      sealed.length - 1,
      boundary,
      boundary * 2 - SEAL_HEADER_LEN,
      SEAL_HEADER_LEN + 3,
      10,
    ]) {
      await expect(collect(unsealStream(pieces(sealed.subarray(0, len)), PASS))).rejects.toThrow();
    }
  });

  it('rejects swapped records', async () => {
    const plain = randomBytes(2 * CHUNK + 100);
    const sealed = await collect(sealStream(pieces(plain), key));
    const rec = CHUNK + SEAL_TAG_LEN;
    const r0 = sealed.subarray(SEAL_HEADER_LEN, SEAL_HEADER_LEN + rec);
    const r1 = sealed.subarray(SEAL_HEADER_LEN + rec, SEAL_HEADER_LEN + 2 * rec);
    const swapped = Buffer.concat([
      sealed.subarray(0, SEAL_HEADER_LEN),
      r1,
      r0,
      sealed.subarray(SEAL_HEADER_LEN + 2 * rec),
    ]);
    await expect(collect(unsealStream(pieces(swapped), PASS))).rejects.toThrow(/did not verify/);
  });

  it('refuses a header asking for more work than encryption ever does', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('x')), key));
    const bad = Buffer.from(sealed);
    bad[6] = 25; // logN
    await expect(collect(unsealStream(pieces(bad), PASS))).rejects.toThrow(/unsupported/);
  });

  it('derives the key once per salt with a cache', async () => {
    const cache = new SealKeyCache(2);
    const spy = jest.spyOn(cache, 'get');
    const a = await collect(sealStream(pieces(Buffer.from('one')), key));
    const b = await collect(sealStream(pieces(Buffer.from('two')), key));
    expect((await collect(unsealStream(pieces(a), PASS, cache))).toString()).toBe('one');
    expect((await collect(unsealStream(pieces(b), PASS, cache))).toString()).toBe('two');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  describe('compatibility with infra/recovery/seal.mjs', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-seal-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('seal.mjs decrypts what the portal encrypts', async () => {
      const plain = randomBytes(CHUNK + 3);
      fs.writeFileSync(path.join(dir, 'pass'), PASS);
      fs.writeFileSync(path.join(dir, 'in.enc'), await collect(sealStream(pieces(plain), key)));
      execFileSync(process.execPath, [
        SEAL_MJS,
        'dec',
        path.join(dir, 'pass'),
        path.join(dir, 'in.enc'),
        path.join(dir, 'out'),
      ]);
      expect(fs.readFileSync(path.join(dir, 'out')).equals(plain)).toBe(true);
    });

    it('seal.mjs refuses a truncated portal file and leaves no output', async () => {
      const sealed = await collect(sealStream(pieces(randomBytes(5000)), key));
      fs.writeFileSync(path.join(dir, 'pass'), PASS);
      fs.writeFileSync(path.join(dir, 'in.enc'), sealed.subarray(0, sealed.length - 7));
      expect(() =>
        execFileSync(
          process.execPath,
          [
            SEAL_MJS,
            'dec',
            path.join(dir, 'pass'),
            path.join(dir, 'in.enc'),
            path.join(dir, 'out'),
          ],
          {
            stdio: 'pipe',
          },
        ),
      ).toThrow();
      expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
    });

    it('the portal decrypts what seal.mjs encrypts', async () => {
      const plain = randomBytes(4096);
      fs.writeFileSync(path.join(dir, 'pass'), PASS);
      fs.writeFileSync(path.join(dir, 'plain'), plain);
      execFileSync(process.execPath, [
        SEAL_MJS,
        'enc',
        path.join(dir, 'pass'),
        path.join(dir, 'plain'),
        path.join(dir, 'x.enc'),
      ]);
      const back = await collect(
        unsealStream(pieces(fs.readFileSync(path.join(dir, 'x.enc'))), PASS),
      );
      expect(back.equals(plain)).toBe(true);
    }, 30_000);
  });
});
