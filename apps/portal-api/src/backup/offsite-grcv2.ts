// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';

/**
 * GRCV2: passphrase encryption, the format `infra/recovery/seal.mjs`
 * writes for host recovery bundles. Off-site backups use it only for
 * the admin's private key file, which is made and kept off the
 * server; the backups themselves use the public-key format in
 * offsite-crypto.ts. The portal never holds the passphrase: only the
 * restore helper reads one, on the server being restored.
 *
 *   header  "GRCV2\n" | logN u8 | r u8 | p u8 | chunkLog2 u8 | salt[16] | iv[12]
 *   records ciphertext[<= chunk] | tag[16], repeated, at least one
 *
 * The key is scrypt(passphrase, salt, N = 2^logN, r, p), 32 bytes.
 * Record i is AES-256-GCM with nonce iv XOR be64(i) in the last 8
 * bytes and AAD header | be64(i) | final u8. A plaintext of N bytes
 * gives ceil(N / chunk) records, or one empty final record when N is
 * 0. A changed, reordered, dropped or truncated record fails to
 * decrypt, and so does a file cut at a record boundary, because the
 * last record it still has was sealed as "not final".
 *
 * Both directions stream: memory is about two records whatever the
 * file size.
 */

export const SEAL_MAGIC = Buffer.from('GRCV2\n');
export const SEAL_HEADER_LEN = SEAL_MAGIC.length + 4 + 16 + 12;
export const SEAL_TAG_LEN = 16;
/** Parameters seal.mjs writes, and the most it will accept. */
export const SEAL_LOG_N = 17;
export const SEAL_R = 8;
export const SEAL_P = 1;
export const SEAL_CHUNK_LOG2 = 20;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export interface SealKey {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function deriveKey(
  passphrase: Buffer,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; allow twice that, as seal.mjs does.
  const maxmem = 256 * 2 ** logN * r;
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 2 ** logN, r, p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * A fresh key with a random salt. `logN` below 17 is for tests only.
 */
export async function newSealKey(
  passphrase: string,
  opts: { logN?: number } = {},
): Promise<SealKey> {
  const logN = opts.logN ?? SEAL_LOG_N;
  if (logN < 14 || logN > SEAL_LOG_N) throw new SealError('unsupported scrypt cost');
  const salt = randomBytes(16);
  const key = await deriveKey(Buffer.from(passphrase, 'utf8'), salt, logN, SEAL_R, SEAL_P);
  return { logN, r: SEAL_R, p: SEAL_P, salt, key };
}

function header(k: SealKey, iv: Buffer): Buffer {
  return Buffer.concat([SEAL_MAGIC, Buffer.from([k.logN, k.r, k.p, SEAL_CHUNK_LOG2]), k.salt, iv]);
}

function nonceFor(iv: Buffer, index: number): Buffer {
  const nonce = Buffer.from(iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(index));
  for (let i = 0; i < 8; i += 1) nonce[4 + i]! ^= counter[i]!;
  return nonce;
}

function aadFor(head: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index));
  tail[8] = final ? 1 : 0;
  return Buffer.concat([head, tail]);
}

/** Bytes a sealed file of `plainBytes` will have. Exact. */
export function sealedSize(plainBytes: number, chunkLog2 = SEAL_CHUNK_LOG2): number {
  const chunk = 2 ** chunkLog2;
  const records = Math.max(1, Math.ceil(plainBytes / chunk));
  return SEAL_HEADER_LEN + plainBytes + records * SEAL_TAG_LEN;
}

/** Collects incoming buffers and hands out exact-size slices. */
export class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;
  push(b: Buffer) {
    if (b.length === 0) return;
    this.parts.push(b);
    this.length += b.length;
  }
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.parts[0]!;
      const want = n - off;
      if (head.length <= want) {
        head.copy(out, off);
        off += head.length;
        this.parts.shift();
      } else {
        head.copy(out, off, 0, want);
        this.parts[0] = head.subarray(want);
        off += want;
      }
    }
    this.length -= n;
    return out;
  }
}

export function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  throw new SealError('unexpected chunk type');
}

/**
 * Encrypt a byte stream. Yields the header, then one buffer per
 * record. A record is held back until the next byte (or the end)
 * arrives, because the final record is sealed differently.
 */
export async function* sealStream(
  source: AsyncIterable<unknown>,
  k: SealKey,
): AsyncGenerator<Buffer> {
  const iv = randomBytes(12);
  const head = header(k, iv);
  const chunk = 2 ** SEAL_CHUNK_LOG2;
  const seal = (plain: Buffer, index: number, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', k.key, nonceFor(iv, index));
    cipher.setAAD(aadFor(head, index, final));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  yield head;
  const q = new ByteQueue();
  let index = 0;
  for await (const piece of source) {
    q.push(toBuffer(piece));
    // Strictly more than a chunk: only then is this record not the last.
    while (q.length > chunk) {
      yield seal(q.take(chunk), index, false);
      index += 1;
    }
  }
  yield seal(q.take(q.length), index, true);
}

interface ParsedHeader {
  head: Buffer;
  logN: number;
  r: number;
  p: number;
  chunkLog2: number;
  salt: Buffer;
  iv: Buffer;
}

function parseHeader(head: Buffer): ParsedHeader {
  if (head.length !== SEAL_HEADER_LEN || !head.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
    throw new SealError('This file is not a sealed GratisGIS key file.');
  }
  const o = SEAL_MAGIC.length;
  const [logN, r, p, chunkLog2] = [head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!];
  // Never spend more than encryption asks for: a crafted header cannot
  // make this process allocate more scrypt memory or a larger record.
  if (
    logN < 14 ||
    logN > SEAL_LOG_N ||
    r < 1 ||
    r > SEAL_R ||
    p < 1 ||
    p > SEAL_P ||
    chunkLog2 < 12 ||
    chunkLog2 > SEAL_CHUNK_LOG2
  ) {
    throw new SealError('The key file has unsupported parameters.');
  }
  return {
    head,
    logN,
    r,
    p,
    chunkLog2,
    salt: head.subarray(o + 4, o + 20),
    iv: head.subarray(o + 20, SEAL_HEADER_LEN),
  };
}

/**
 * Derived keys by salt, so decrypting many objects of one run pays for
 * scrypt once. Keyed by a hash of the passphrase as well, so a wrong
 * passphrase never reuses a right one's key.
 */
export class SealKeyCache {
  private readonly keys = new Map<string, Buffer>();
  constructor(private readonly max = 8) {}
  async get(passphrase: Buffer, h: ParsedHeader): Promise<Buffer> {
    const id = createHash('sha256')
      .update(passphrase)
      .update(h.head.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + 20))
      .digest('hex');
    const hit = this.keys.get(id);
    if (hit) return hit;
    const key = await deriveKey(passphrase, h.salt, h.logN, h.r, h.p);
    if (this.keys.size >= this.max) {
      const first = this.keys.keys().next().value;
      if (first !== undefined) this.keys.delete(first);
    }
    this.keys.set(id, key);
    return key;
  }
}

/**
 * Decrypt a sealed byte stream. Plaintext is yielded record by record
 * as each one verifies, so a consumer must treat what it received as
 * untrusted until the generator finishes without throwing: a
 * truncated or tampered file throws at the bad record, after the good
 * ones before it were already yielded.
 */
export async function* unsealStream(
  source: AsyncIterable<unknown>,
  passphrase: string | Buffer,
  cache: SealKeyCache = new SealKeyCache(1),
): AsyncGenerator<Buffer> {
  const pass = typeof passphrase === 'string' ? Buffer.from(passphrase, 'utf8') : passphrase;
  const q = new ByteQueue();
  let h: ParsedHeader | null = null;
  let key: Buffer | null = null;
  let record = 0;
  let index = 0;
  const open = (buf: Buffer, final: boolean): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', key!, nonceFor(h!.iv, index));
    decipher.setAAD(aadFor(h!.head, index, final));
    decipher.setAuthTag(buf.subarray(buf.length - SEAL_TAG_LEN));
    try {
      return Buffer.concat([
        decipher.update(buf.subarray(0, buf.length - SEAL_TAG_LEN)),
        decipher.final(),
      ]);
    } catch {
      throw new SealError(
        'The key file did not open: the passphrase is wrong, or the file was changed or cut short.',
      );
    }
  };
  for await (const piece of source) {
    q.push(toBuffer(piece));
    if (!h && q.length >= SEAL_HEADER_LEN) {
      h = parseHeader(q.take(SEAL_HEADER_LEN));
      key = await cache.get(pass, h);
      record = 2 ** h.chunkLog2 + SEAL_TAG_LEN;
    }
    while (h && q.length > record) {
      yield open(q.take(record), false);
      index += 1;
    }
  }
  if (!h) throw new SealError('The key file is too short.');
  if (q.length < SEAL_TAG_LEN) throw new SealError('The key file is cut short.');
  yield open(q.take(q.length), true);
}
