// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import {
  ByteQueue,
  newSealKey,
  SealKeyCache,
  sealStream as grcv2SealStream,
  toBuffer,
  unsealStream as grcv2UnsealStream,
} from './offsite-grcv2.js';

/**
 * Public-key encryption for off-site backup files.
 *
 * The portal holds only the admin's X25519 public key, so it can
 * encrypt each file but never decrypt one. The private key is made on
 * the admin's own machine by infra/recovery/offsite-key.mjs and kept
 * there, in a file sealed with a passphrase (GRCV2). That script
 * decrypts these files with nothing but Node.js.
 *
 * Format GROF1, byte for byte (docs/operations/offsite-backup-format.md):
 *
 *   header  "GROF1\n" | chunkLog2 u8 | keyId[16] | ephemeral[32]
 *           | wrappedKey[32] | wrapTag[16] | iv[12]          (115 bytes)
 *   records ciphertext[<= chunk] | tag[16], repeated, at least one
 *
 * Each file has its own random 32-byte data key. It is wrapped for the
 * recipient: shared = X25519(ephemeral private, recipient public),
 * refused when all zero; wrapKey = HKDF-SHA-256(ikm = shared,
 * salt = ephemeral public | recipient public, info = WRAP_INFO, 32);
 * wrappedKey | wrapTag = AES-256-GCM(wrapKey, nonce = 12 zero bytes,
 * aad = header bytes 0..55, dataKey). A zero nonce is safe because
 * every wrapKey is used once. keyId is the recipient key's
 * fingerprint, so a reader can say which key a file needs.
 *
 * The records are the GRCV2 body under the data key: record i is
 * AES-256-GCM with nonce iv XOR be64(i) in the last 8 bytes and AAD
 * header | be64(i) | final u8. A changed header, wrapped key or
 * record, records swapped or dropped, a file cut anywhere (also at a
 * record boundary) and bytes after the final record all fail.
 */

export const OFFSITE_MAGIC = Buffer.from('GROF1\n');
export const OFFSITE_FORMAT = 'GROF1';
const KEY_ID_LEN = 16;
const POINT_LEN = 32;
const WRAP_LEN = 32 + 16;
const IV_LEN = 12;
/** Bytes of the header the wrapped key is bound to. */
const WRAP_AAD_LEN = OFFSITE_MAGIC.length + 1 + KEY_ID_LEN + POINT_LEN;
export const OFFSITE_HEADER_LEN = WRAP_AAD_LEN + WRAP_LEN + IV_LEN;
export const OFFSITE_TAG_LEN = 16;
export const OFFSITE_CHUNK_LOG2 = 20;
const MIN_CHUNK_LOG2 = 12;

const WRAP_INFO = Buffer.from('gratisgis-offsite-v1 data key wrap', 'utf8');
const FINGERPRINT_LABEL = Buffer.from('gratisgis-offsite-key-fingerprint-v1\0', 'utf8');
const PUBLIC_CHECK_LABEL = Buffer.from('gratisgis-offsite-public-key-v1\0', 'utf8');
const PRIVATE_CHECK_LABEL = Buffer.from('gratisgis-offsite-private-key-v1\0', 'utf8');
export const PUBLIC_KEY_PREFIX = 'ggpub1:';
export const PRIVATE_KEY_PREFIX = 'ggsec1:';
export const KEY_FILE_KIND = 'gratisgis-offsite-private-key';

export class OffsiteCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteCryptoError';
  }
}

export interface OffsitePublicKey {
  readonly raw: Buffer;
  readonly keyObject: KeyObject;
  readonly fingerprint: Buffer;
  /** The text form an admin pastes: ggpub1:... */
  readonly text: string;
  /** 32 hex digits in groups of four. */
  readonly fingerprintText: string;
}

export interface OffsitePrivateKey {
  readonly keyObject: KeyObject;
  readonly publicKey: OffsitePublicKey;
}

// ---------------------------------------------------------------
// Keys and their text forms
// ---------------------------------------------------------------

function check4(label: Buffer, raw: Buffer): Buffer {
  return createHash('sha256').update(label).update(raw).digest().subarray(0, 4);
}

export function fingerprintOf(raw: Buffer): Buffer {
  return createHash('sha256')
    .update(FINGERPRINT_LABEL)
    .update(raw)
    .digest()
    .subarray(0, KEY_ID_LEN);
}

export function fingerprintText(fp: Buffer): string {
  return (fp.toString('hex').match(/.{4}/g) ?? []).join('-');
}

/**
 * A fingerprint as typed or pasted: 32 hex digits, any case, with or
 * without dashes, colons or spaces. Null when it is not one.
 */
export function parseFingerprint(text: string): Buffer | null {
  const hex = text.replace(/[\s:-]/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function publicFromRaw(raw: Buffer): OffsitePublicKey {
  const keyObject = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
  const fingerprint = fingerprintOf(raw);
  return {
    raw,
    keyObject,
    fingerprint,
    text: `${PUBLIC_KEY_PREFIX}${Buffer.concat([raw, check4(PUBLIC_CHECK_LABEL, raw)]).toString('base64url')}`,
    fingerprintText: fingerprintText(fingerprint),
  };
}

/** True when the text holds something that looks like a private key. */
export function looksLikePrivateKey(text: string): boolean {
  return (
    text.includes(PRIVATE_KEY_PREFIX) || text.includes('GRCV2') || text.includes(KEY_FILE_KIND)
  );
}

/**
 * Parse the text form of a public key. White space anywhere is
 * ignored, so a key broken over lines still reads. Errors are plain
 * sentences and never repeat what was pasted.
 */
export function parsePublicKey(input: string): OffsitePublicKey {
  const text = input.replace(/\s+/g, '');
  if (looksLikePrivateKey(text)) {
    throw new OffsiteCryptoError(
      'That is a private key. The portal only takes the public key (it starts with ggpub1:). Keep the private key off this server.',
    );
  }
  if (!text.startsWith(PUBLIC_KEY_PREFIX)) {
    if (/^ggpub\d+:/.test(text)) {
      throw new OffsiteCryptoError(
        'This public key is from a newer version of the key tool. Update the portal or make the key with the tool from this release.',
      );
    }
    throw new OffsiteCryptoError(
      'This is not a GratisGIS off-site public key. It starts with ggpub1: and comes from infra/recovery/offsite-key.mjs.',
    );
  }
  const body = text.slice(PUBLIC_KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{48}$/.test(body)) {
    throw new OffsiteCryptoError('The public key is the wrong length. Copy the whole line again.');
  }
  const bytes = Buffer.from(body, 'base64url');
  const raw = bytes.subarray(0, POINT_LEN);
  if (!timingSafeEqual(bytes.subarray(POINT_LEN), check4(PUBLIC_CHECK_LABEL, raw))) {
    throw new OffsiteCryptoError(
      'The public key has a typo: its checksum does not match. Copy the whole line again.',
    );
  }
  if (raw.every((b) => b === 0)) {
    throw new OffsiteCryptoError('The public key is not usable.');
  }
  return publicFromRaw(Buffer.from(raw));
}

function privateText(d: Buffer): string {
  return `${PRIVATE_KEY_PREFIX}${Buffer.concat([d, check4(PRIVATE_CHECK_LABEL, d)]).toString('base64url')}`;
}

/** PKCS#8 wrapping of a raw X25519 private key (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function privateFromRaw(d: Buffer): OffsitePrivateKey {
  const keyObject = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, d]),
    format: 'der',
    type: 'pkcs8',
  });
  const x = Buffer.from(
    (createPublicKey(keyObject).export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return { keyObject, publicKey: publicFromRaw(x) };
}

function parsePrivateText(text: string): Buffer {
  if (!text.startsWith(PRIVATE_KEY_PREFIX))
    throw new OffsiteCryptoError('The key file is damaged.');
  const body = text.slice(PRIVATE_KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{48}$/.test(body)) throw new OffsiteCryptoError('The key file is damaged.');
  const bytes = Buffer.from(body, 'base64url');
  const d = bytes.subarray(0, POINT_LEN);
  if (!timingSafeEqual(bytes.subarray(POINT_LEN), check4(PRIVATE_CHECK_LABEL, d))) {
    throw new OffsiteCryptoError('The key file is damaged.');
  }
  return Buffer.from(d);
}

/**
 * The passphrase of a key file as the tools use it: one trailing line
 * break (\n or \r\n) dropped, then Unicode NFC, so the same words
 * typed on different systems give the same bytes.
 */
export function normalizePassphrase(raw: string): string {
  return raw.replace(/\r?\n$/, '').normalize('NFC');
}

export const KEY_PASSPHRASE_MIN = 16;

/** Throws a plain sentence when a key file passphrase is unusable. */
export function checkKeyPassphrase(p: string): void {
  if (p.length < KEY_PASSPHRASE_MIN) {
    throw new OffsiteCryptoError(
      `The key file passphrase must be at least ${KEY_PASSPHRASE_MIN} characters.`,
    );
  }
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c < 32 || c === 127) {
      throw new OffsiteCryptoError(
        'The key file passphrase cannot contain line breaks or control characters.',
      );
    }
  }
}

/** A new key pair. For tests; admins use infra/recovery/offsite-key.mjs. */
export function generateOffsiteKeyPair(): OffsitePrivateKey {
  const { privateKey } = generateKeyPairSync('x25519');
  const d = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  return privateFromRaw(d);
}

async function collectAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const b of it) out.push(b);
  return Buffer.concat(out);
}

async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  yield buf;
}

/** The sealed key file, as offsite-key.mjs writes it. For tests. */
export async function sealKeyFile(
  key: OffsitePrivateKey,
  passphrase: string,
  opts: { logN?: number } = {},
): Promise<Buffer> {
  const pass = normalizePassphrase(passphrase);
  checkKeyPassphrase(pass);
  const d = Buffer.from((key.keyObject.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  const body = JSON.stringify({
    kind: KEY_FILE_KIND,
    version: 1,
    privateKey: privateText(d),
    publicKey: key.publicKey.text,
    fingerprint: key.publicKey.fingerprintText,
  });
  const k = await newSealKey(pass, opts);
  return collectAll(grcv2SealStream(once(Buffer.from(body, 'utf8')), k));
}

/**
 * Open the admin's sealed key file. Only the restore helper calls
 * this, on the server being restored; the running portal never does.
 */
export async function openKeyFile(file: Buffer, passphrase: string): Promise<OffsitePrivateKey> {
  if (file.length > 64 * 1024) throw new OffsiteCryptoError('This is not a GratisGIS key file.');
  const pass = normalizePassphrase(passphrase);
  const plain = await collectAll(grcv2UnsealStream(once(file), pass, new SealKeyCache(1)));
  let parsed: { kind?: unknown; version?: unknown; privateKey?: unknown; publicKey?: unknown };
  try {
    parsed = JSON.parse(plain.toString('utf8')) as typeof parsed;
  } catch {
    throw new OffsiteCryptoError('The key file is damaged.');
  }
  if (
    parsed.kind !== KEY_FILE_KIND ||
    parsed.version !== 1 ||
    typeof parsed.privateKey !== 'string'
  ) {
    throw new OffsiteCryptoError('This is not a GratisGIS off-site key file.');
  }
  const key = privateFromRaw(parsePrivateText(parsed.privateKey));
  if (typeof parsed.publicKey === 'string' && parsed.publicKey !== key.publicKey.text) {
    throw new OffsiteCryptoError('The key file is damaged: its two halves do not match.');
  }
  return key;
}

// ---------------------------------------------------------------
// Files
// ---------------------------------------------------------------

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

/** X25519, refusing the all-zero result a low-order point gives. */
function agree(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    throw new OffsiteCryptoError('The key agreement failed: the file or key is not valid.');
  }
  if (shared.every((b) => b === 0)) {
    throw new OffsiteCryptoError('The key agreement failed: the file or key is not valid.');
  }
  return shared;
}

function wrapKeyFor(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), WRAP_INFO, 32),
  );
}

/** Bytes a sealed file of `plainBytes` will have. Exact. */
export function sealedSize(plainBytes: number, chunkLog2 = OFFSITE_CHUNK_LOG2): number {
  const chunk = 2 ** chunkLog2;
  const records = Math.max(1, Math.ceil(plainBytes / chunk));
  return OFFSITE_HEADER_LEN + plainBytes + records * OFFSITE_TAG_LEN;
}

/**
 * Encrypt a byte stream to a public key. Yields the header, then one
 * buffer per record. Memory is about two records whatever the size.
 */
export async function* sealStream(
  source: AsyncIterable<unknown>,
  recipient: OffsitePublicKey,
): AsyncGenerator<Buffer> {
  const dataKey = randomBytes(32);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = Buffer.from(
    (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  const shared = agree(eph.privateKey, recipient.keyObject);
  const wrapKey = wrapKeyFor(shared, ephRaw, recipient.raw);
  const prefix = Buffer.concat([
    OFFSITE_MAGIC,
    Buffer.from([OFFSITE_CHUNK_LOG2]),
    recipient.fingerprint,
    ephRaw,
  ]);
  const w = createCipheriv('aes-256-gcm', wrapKey, Buffer.alloc(IV_LEN));
  w.setAAD(prefix);
  const wrapped = Buffer.concat([w.update(dataKey), w.final(), w.getAuthTag()]);
  const iv = randomBytes(IV_LEN);
  const head = Buffer.concat([prefix, wrapped, iv]);
  const chunk = 2 ** OFFSITE_CHUNK_LOG2;
  const seal = (plain: Buffer, index: number, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonceFor(iv, index));
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

export interface ParsedOffsiteHeader {
  head: Buffer;
  chunkLog2: number;
  keyId: Buffer;
  ephemeral: Buffer;
  wrapped: Buffer;
  iv: Buffer;
}

export function parseOffsiteHeader(head: Buffer): ParsedOffsiteHeader {
  if (
    head.length !== OFFSITE_HEADER_LEN ||
    !head.subarray(0, OFFSITE_MAGIC.length).equals(OFFSITE_MAGIC)
  ) {
    throw new OffsiteCryptoError('This file is not an encrypted GratisGIS off-site backup.');
  }
  let o = OFFSITE_MAGIC.length;
  const chunkLog2 = head[o]!;
  o += 1;
  // Never allocate a larger record than encryption writes.
  if (chunkLog2 < MIN_CHUNK_LOG2 || chunkLog2 > OFFSITE_CHUNK_LOG2) {
    throw new OffsiteCryptoError('The encrypted file has unsupported parameters.');
  }
  const keyId = head.subarray(o, o + KEY_ID_LEN);
  o += KEY_ID_LEN;
  const ephemeral = head.subarray(o, o + POINT_LEN);
  o += POINT_LEN;
  const wrapped = head.subarray(o, o + WRAP_LEN);
  o += WRAP_LEN;
  return { head, chunkLog2, keyId, ephemeral, wrapped, iv: head.subarray(o, o + IV_LEN) };
}

function unwrap(h: ParsedOffsiteHeader, key: OffsitePrivateKey): Buffer {
  if (!timingSafeEqual(h.keyId, key.publicKey.fingerprint)) {
    throw new OffsiteCryptoError(
      `This file was encrypted for a different key (fingerprint ${fingerprintText(h.keyId)}); this key is ${key.publicKey.fingerprintText}.`,
    );
  }
  let ephObj: KeyObject;
  try {
    ephObj = createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(h.ephemeral).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw new OffsiteCryptoError('The key agreement failed: the file or key is not valid.');
  }
  const shared = agree(key.keyObject, ephObj);
  const wrapKey = wrapKeyFor(shared, h.ephemeral, key.publicKey.raw);
  const d = createDecipheriv('aes-256-gcm', wrapKey, Buffer.alloc(IV_LEN));
  d.setAAD(h.head.subarray(0, WRAP_AAD_LEN));
  d.setAuthTag(h.wrapped.subarray(32));
  try {
    return Buffer.concat([d.update(h.wrapped.subarray(0, 32)), d.final()]);
  } catch {
    throw new OffsiteCryptoError(
      'The encrypted file did not verify: it was made for another key, or it was changed.',
    );
  }
}

/**
 * Decrypt a sealed byte stream. Plaintext is yielded record by record
 * as each one verifies, so a consumer must treat what it received as
 * untrusted until the generator finishes without throwing.
 */
export async function* unsealStream(
  source: AsyncIterable<unknown>,
  key: OffsitePrivateKey,
): AsyncGenerator<Buffer> {
  const q = new ByteQueue();
  let h: ParsedOffsiteHeader | null = null;
  let dataKey: Buffer | null = null;
  let record = 0;
  let index = 0;
  const open = (buf: Buffer, final: boolean): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', dataKey!, nonceFor(h!.iv, index));
    decipher.setAAD(aadFor(h!.head, index, final));
    decipher.setAuthTag(buf.subarray(buf.length - OFFSITE_TAG_LEN));
    try {
      return Buffer.concat([
        decipher.update(buf.subarray(0, buf.length - OFFSITE_TAG_LEN)),
        decipher.final(),
      ]);
    } catch {
      throw new OffsiteCryptoError(
        'The encrypted file did not verify: it was changed, cut short, or has extra bytes.',
      );
    }
  };
  for await (const piece of source) {
    q.push(toBuffer(piece));
    if (!h && q.length >= OFFSITE_HEADER_LEN) {
      h = parseOffsiteHeader(q.take(OFFSITE_HEADER_LEN));
      dataKey = unwrap(h, key);
      record = 2 ** h.chunkLog2 + OFFSITE_TAG_LEN;
    }
    while (h && q.length > record) {
      yield open(q.take(record), false);
      index += 1;
    }
  }
  if (!h) throw new OffsiteCryptoError('The encrypted file is too short to be a backup.');
  if (q.length < OFFSITE_TAG_LEN) throw new OffsiteCryptoError('The encrypted file is cut short.');
  yield open(q.take(q.length), true);
}
