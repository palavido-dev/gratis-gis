// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkKeyPassphrase,
  fingerprintOf,
  fingerprintText,
  generateOffsiteKeyPair,
  looksLikePrivateKey,
  normalizePassphrase,
  OFFSITE_HEADER_LEN,
  OFFSITE_TAG_LEN,
  openKeyFile,
  parseFingerprint,
  parsePublicKey,
  sealedSize,
  sealKeyFile,
  sealStream,
  unsealStream,
  type OffsitePrivateKey,
} from './offsite-crypto.js';

const CHUNK = 1024 * 1024;
const RECORD = CHUNK + OFFSITE_TAG_LEN;
const KEY_MJS = path.resolve(__dirname, '../../../../infra/recovery/offsite-key.mjs');
const SEAL_MJS = path.resolve(__dirname, '../../../../infra/recovery/seal.mjs');
const PASS = 'a key file passphrase, long enough';

async function* pieces(buf: Buffer, step = 100_000): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
  if (buf.length === 0) return;
}

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(b);
  return Buffer.concat(out);
}

describe('off-site public-key format (GROF1)', () => {
  let key: OffsitePrivateKey;
  beforeAll(() => {
    key = generateOffsiteKeyPair();
  });

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 5])(
    'round-trips %i bytes and matches the predicted size',
    async (n) => {
      const plain = randomBytes(n);
      const sealed = await collect(sealStream(pieces(plain), key.publicKey));
      expect(sealed.length).toBe(sealedSize(n));
      expect(sealed.subarray(0, 6).toString()).toBe('GROF1\n');
      const back = await collect(unsealStream(pieces(sealed, 77_777), key));
      expect(back.equals(plain)).toBe(true);
    },
  );

  it('does not contain the plaintext, and every file has its own wrapped key', async () => {
    const plain = Buffer.from('PGDMP CREATE TABLE organization '.repeat(200));
    const a = await collect(sealStream(pieces(plain), key.publicKey));
    const b = await collect(sealStream(pieces(plain), key.publicKey));
    expect(a.includes(Buffer.from('CREATE TABLE'))).toBe(false);
    expect(a.subarray(23, OFFSITE_HEADER_LEN).equals(b.subarray(23, OFFSITE_HEADER_LEN))).toBe(
      false,
    );
  });

  it('records the key fingerprint in the header', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('x')), key.publicKey));
    expect(sealed.subarray(7, 23).equals(key.publicKey.fingerprint)).toBe(true);
  });

  it('refuses the wrong key and names the fingerprint the file needs', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('hello')), key.publicKey));
    const other = generateOffsiteKeyPair();
    await expect(collect(unsealStream(pieces(sealed), other))).rejects.toThrow(
      new RegExp(`different key \\(fingerprint ${key.publicKey.fingerprintText}\\)`),
    );
  });

  it('refuses a file whose key id was changed to match another key', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('hello')), key.publicKey));
    const other = generateOffsiteKeyPair();
    const bad = Buffer.from(sealed);
    other.publicKey.fingerprint.copy(bad, 7);
    await expect(collect(unsealStream(pieces(bad), other))).rejects.toThrow(/did not verify/);
  });

  it.each([
    ['chunk size byte', 6],
    ['ephemeral key', 30],
    ['wrapped key', 60],
    ['wrap tag', 95],
    ['record iv', 110],
  ])('refuses a changed header byte (%s)', async (_what, at) => {
    const sealed = await collect(sealStream(pieces(randomBytes(5000)), key.publicKey));
    const bad = Buffer.from(sealed);
    bad[at] = bad[at]! ^ 0x01;
    await expect(collect(unsealStream(pieces(bad), key))).rejects.toThrow();
  });

  it('refuses a changed record byte', async () => {
    const sealed = await collect(sealStream(pieces(randomBytes(CHUNK + 10)), key.publicKey));
    for (const at of [OFFSITE_HEADER_LEN + 5, OFFSITE_HEADER_LEN + RECORD - 1, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = bad[at]! ^ 0x01;
      await expect(collect(unsealStream(pieces(bad), key))).rejects.toThrow(/did not verify/);
    }
  });

  it('refuses a file cut at a record boundary, mid-record, or in the header', async () => {
    const sealed = await collect(sealStream(pieces(randomBytes(2 * CHUNK + 100)), key.publicKey));
    for (const len of [
      OFFSITE_HEADER_LEN + RECORD,
      OFFSITE_HEADER_LEN + 2 * RECORD,
      sealed.length - 1,
      OFFSITE_HEADER_LEN + 3,
      OFFSITE_HEADER_LEN - 1,
      10,
    ]) {
      await expect(collect(unsealStream(pieces(sealed.subarray(0, len)), key))).rejects.toThrow();
    }
  });

  it('refuses swapped records', async () => {
    const sealed = await collect(sealStream(pieces(randomBytes(2 * CHUNK + 100)), key.publicKey));
    const h = OFFSITE_HEADER_LEN;
    const swapped = Buffer.concat([
      sealed.subarray(0, h),
      sealed.subarray(h + RECORD, h + 2 * RECORD),
      sealed.subarray(h, h + RECORD),
      sealed.subarray(h + 2 * RECORD),
    ]);
    await expect(collect(unsealStream(pieces(swapped), key))).rejects.toThrow(/did not verify/);
  });

  it('refuses trailing bytes after the final record', async () => {
    for (const n of [10, CHUNK]) {
      const sealed = await collect(sealStream(pieces(randomBytes(n)), key.publicKey));
      for (const extra of [Buffer.from([0]), randomBytes(OFFSITE_TAG_LEN), randomBytes(RECORD)]) {
        await expect(
          collect(unsealStream(pieces(Buffer.concat([sealed, extra])), key)),
        ).rejects.toThrow();
      }
    }
  });

  it('refuses a low-order or all-zero ephemeral key', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('x')), key.publicKey));
    // u = 0 and u = 1 are points of small order on Curve25519.
    for (const u of [Buffer.alloc(32), Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])]) {
      const bad = Buffer.from(sealed);
      u.copy(bad, 23);
      await expect(collect(unsealStream(pieces(bad), key))).rejects.toThrow(/key agreement failed/);
    }
  });

  it('refuses a header asking for larger records than encryption writes', async () => {
    const sealed = await collect(sealStream(pieces(Buffer.from('x')), key.publicKey));
    const bad = Buffer.from(sealed);
    bad[6] = 30;
    await expect(collect(unsealStream(pieces(bad), key))).rejects.toThrow(/unsupported/);
  });
});

describe('key text forms', () => {
  it('round-trips the public key text and its checksum catches a typo', () => {
    const k = generateOffsiteKeyPair();
    const text = k.publicKey.text;
    expect(text).toMatch(/^ggpub1:[A-Za-z0-9_-]{48}$/);
    expect(parsePublicKey(text).raw.equals(k.publicKey.raw)).toBe(true);
    // Line breaks and spaces from copying are ignored.
    expect(parsePublicKey(`  ${text.slice(0, 20)}\n${text.slice(20)}  `).text).toBe(text);
    const i = 15;
    const typo = text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);
    expect(() => parsePublicKey(typo)).toThrow(/checksum/);
    expect(() => parsePublicKey(text.slice(0, -1))).toThrow(/wrong length/);
    expect(() => parsePublicKey('ssh-ed25519 AAAA')).toThrow(/not a GratisGIS/);
    expect(() => parsePublicKey(text.replace('ggpub1:', 'ggpub2:'))).toThrow(/newer version/);
  });

  it('refuses private key material in place of a public key', () => {
    expect(() => parsePublicKey('ggsec1:abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv')).toThrow(
      /private key/,
    );
    expect(looksLikePrivateKey('GRCV2\n...')).toBe(true);
    expect(looksLikePrivateKey(generateOffsiteKeyPair().publicKey.text)).toBe(false);
  });

  it('fingerprints are stable, documented and parse back', () => {
    const raw = Buffer.alloc(32, 7);
    const expected = createHash('sha256')
      .update('gratisgis-offsite-key-fingerprint-v1\0')
      .update(raw)
      .digest()
      .subarray(0, 16);
    expect(fingerprintOf(raw).equals(expected)).toBe(true);
    // A fixed vector, so a change to the derivation is noticed.
    expect(fingerprintText(fingerprintOf(raw))).toBe('8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184');
    expect(fingerprintText(expected)).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
    const fp = fingerprintText(expected);
    expect(parseFingerprint(fp)!.equals(expected)).toBe(true);
    expect(parseFingerprint(fp.toUpperCase().replace(/-/g, ':'))!.equals(expected)).toBe(true);
    expect(parseFingerprint('not hex')).toBeNull();
  });

  it('normalises a passphrase: one trailing line break, CRLF, NFC', () => {
    const nfd = 'Café au lait, sans sucre';
    expect(normalizePassphrase(`${nfd}\r\n`)).toBe('Café au lait, sans sucre');
    expect(normalizePassphrase('passphrase\n\n')).toBe('passphrase\n');
    expect(() => checkKeyPassphrase('short')).toThrow(/at least 16/);
    expect(() => checkKeyPassphrase('sixteen chars ok\nmore')).toThrow(/line breaks/);
  });

  it('a sealed key file opens with the passphrase typed any of those ways', async () => {
    const k = generateOffsiteKeyPair();
    const file = await sealKeyFile(k, 'Café au lait, sans sucre', { logN: 14 });
    for (const typed of ['Café au lait, sans sucre', 'Café au lait, sans sucre\r\n']) {
      expect((await openKeyFile(file, typed)).publicKey.text).toBe(k.publicKey.text);
    }
    await expect(openKeyFile(file, 'the wrong passphrase entirely')).rejects.toThrow(
      /did not open/,
    );
  });
});

describe('interop with infra/recovery/offsite-key.mjs', () => {
  let dir: string;
  const node = (args: string[], input?: Buffer | string) =>
    spawnSync(process.execPath, [KEY_MJS, ...args], {
      input,
      env: { PATH: process.env.PATH ?? '', GG_OFFSITE_KEY_TEST_LOGN: '14' },
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-okey-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a key made by the script opens here, and files go both ways', async () => {
    fs.writeFileSync(path.join(dir, 'pass'), `${PASS}\r\n`);
    const gen = node([
      'generate',
      path.join(dir, 'k.ggkey'),
      '--passphrase-file',
      path.join(dir, 'pass'),
    ]);
    expect(gen.status).toBe(0);
    const out = gen.stdout.toString();
    const pubText = /Public key: +(\S+)/.exec(out)![1]!;
    const fp = /Fingerprint: +(\S+)/.exec(out)![1]!;
    expect(fs.statSync(path.join(dir, 'k.ggkey')).mode & 0o777).toBe(0o600);
    const key = await openKeyFile(fs.readFileSync(path.join(dir, 'k.ggkey')), PASS);
    expect(key.publicKey.text).toBe(pubText);
    expect(key.publicKey.fingerprintText).toBe(fp);

    // Portal encrypts, script decrypts.
    const plain = randomBytes(CHUNK + 3);
    fs.writeFileSync(
      path.join(dir, 'a.enc'),
      await collect(sealStream(pieces(plain), key.publicKey)),
    );
    const dec = node([
      'decrypt',
      path.join(dir, 'k.ggkey'),
      path.join(dir, 'a.enc'),
      path.join(dir, 'a.out'),
      '--passphrase-file',
      path.join(dir, 'pass'),
    ]);
    expect(dec.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'a.out')).equals(plain)).toBe(true);

    // Script encrypts, portal decrypts.
    fs.writeFileSync(path.join(dir, 'b'), plain.subarray(0, 4000));
    expect(node(['encrypt', pubText, path.join(dir, 'b'), path.join(dir, 'b.enc')]).status).toBe(0);
    const back = await collect(unsealStream(pieces(fs.readFileSync(path.join(dir, 'b.enc'))), key));
    expect(back.equals(plain.subarray(0, 4000))).toBe(true);

    // The passphrase on standard input, and the fingerprint command.
    const pub = node(['public', path.join(dir, 'k.ggkey')], `${PASS}\n`);
    expect(pub.stdout.toString()).toContain(pubText);
    expect(node(['fingerprint', pubText]).stdout.toString().trim()).toBe(fp);
  }, 30_000);

  it('a key file sealed here opens with the script, and seal.mjs opens the key file', async () => {
    const key = generateOffsiteKeyPair();
    fs.writeFileSync(path.join(dir, 'k.ggkey'), await sealKeyFile(key, PASS, { logN: 14 }));
    fs.writeFileSync(path.join(dir, 'pass'), PASS);
    const pub = node([
      'public',
      path.join(dir, 'k.ggkey'),
      '--passphrase-file',
      path.join(dir, 'pass'),
    ]);
    expect(pub.stdout.toString()).toContain(key.publicKey.fingerprintText);
    execFileSync(process.execPath, [
      SEAL_MJS,
      'dec',
      path.join(dir, 'pass'),
      path.join(dir, 'k.ggkey'),
      path.join(dir, 'k.json'),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'k.json'), 'utf8')).publicKey).toBe(
      key.publicKey.text,
    );
  }, 30_000);

  it('the script refuses a truncated or tampered file and leaves no output', async () => {
    const key = generateOffsiteKeyPair();
    fs.writeFileSync(path.join(dir, 'k.ggkey'), await sealKeyFile(key, PASS, { logN: 14 }));
    fs.writeFileSync(path.join(dir, 'pass'), PASS);
    const sealed = await collect(sealStream(pieces(randomBytes(3 * 1000)), key.publicKey));
    for (const bad of [
      sealed.subarray(0, sealed.length - 3),
      Buffer.concat([sealed, Buffer.from([1])]),
    ]) {
      fs.writeFileSync(path.join(dir, 'x.enc'), bad);
      const r = node([
        'decrypt',
        path.join(dir, 'k.ggkey'),
        path.join(dir, 'x.enc'),
        path.join(dir, 'x.out'),
        '--passphrase-file',
        path.join(dir, 'pass'),
      ]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(dir, 'x.out'))).toBe(false);
    }
    // And a wrong passphrase, without echoing it.
    fs.writeFileSync(path.join(dir, 'wrong'), 'not the right passphrase at all');
    const r = node([
      'public',
      path.join(dir, 'k.ggkey'),
      '--passphrase-file',
      path.join(dir, 'wrong'),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/did not open/);
    expect(r.stderr.toString()).not.toContain('not the right passphrase');
  }, 30_000);

  it('the script refuses to replace an existing key file', () => {
    fs.writeFileSync(path.join(dir, 'pass'), PASS);
    fs.writeFileSync(path.join(dir, 'k.ggkey'), 'keep me');
    const r = node([
      'generate',
      path.join(dir, 'k.ggkey'),
      '--passphrase-file',
      path.join(dir, 'pass'),
    ]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(path.join(dir, 'k.ggkey'), 'utf8')).toBe('keep me');
  });
});
