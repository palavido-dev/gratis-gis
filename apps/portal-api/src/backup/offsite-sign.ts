// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

import type { ArtifactTrust } from './offsite-rules.js';

/**
 * Signatures on off-site copies.
 *
 * Copies are encrypted to the admin's public key, which is not secret,
 * so anyone who can write to the bucket can add a copy that decrypts.
 * Each copy therefore also carries an Ed25519 signature made with a
 * key only this server holds (the signing key). The admin keeps the
 * matching verify key in their key file, and the restore checks the
 * signature before it decrypts or changes anything.
 *
 * What is signed is a short manifest, not the copy itself: the copy's
 * name, folder, portal install id, exact size, SHA-256 of its
 * encrypted bytes, the encryption key fingerprint and the time it was
 * made. The byte layout is in docs/operations/offsite-backup-format.md
 * and is the same in infra/recovery/offsite-key.mjs.
 *
 * Manifest bytes: ASCII lines, each ending in "\n" (0x0a), no other
 * white space:
 *
 *   gratisgis-offsite-signed-v1
 *   <field>=<value>
 *   ...
 *
 * with the fields of its kind in exactly the order of ARCHIVE_FIELDS or
 * MIRROR_FIELDS. A reader refuses anything else: another order, a
 * missing or extra field, a value outside its rule, a "\r", a missing
 * final "\n". So one manifest has exactly one byte form.
 */

export const VERIFY_KEY_PREFIX = 'ggver1:';
export const SIGNED_HEADER = 'gratisgis-offsite-signed-v1';
export const SIGNATURE_VERSION = 1;
const VERIFY_CHECK_LABEL = Buffer.from('gratisgis-offsite-verify-key-v1\0', 'utf8');
const VERIFY_FP_LABEL = Buffer.from('gratisgis-offsite-verify-key-fingerprint-v1\0', 'utf8');
/** PKCS#8 wrapping of a raw Ed25519 private key (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MAX_MANIFEST = 4096;

export class OffsiteSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteSignError';
  }
}

export interface OffsiteVerifyKey {
  readonly raw: Buffer;
  readonly keyObject: KeyObject;
  readonly fingerprint: Buffer;
  /** 32 hex digits in groups of four. */
  readonly fingerprintText: string;
  /** The text form: ggver1:... */
  readonly text: string;
}

export interface OffsiteSigningKey {
  /** The 32-byte Ed25519 seed. Never logged, returned or uploaded. */
  readonly seed: Buffer;
  readonly keyObject: KeyObject;
  readonly verifyKey: OffsiteVerifyKey;
}

// ---------------------------------------------------------------
// Keys
// ---------------------------------------------------------------

function groups(fp: Buffer): string {
  const hex = fp.toString('hex');
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 4) out.push(hex.slice(i, i + 4));
  return out.join('-');
}

function verifyCheck(raw: Buffer): Buffer {
  return createHash('sha256').update(VERIFY_CHECK_LABEL).update(raw).digest().subarray(0, 4);
}

export function verifyFingerprintOf(raw: Buffer): Buffer {
  return createHash('sha256').update(VERIFY_FP_LABEL).update(raw).digest().subarray(0, 16);
}

export function verifyKeyFromRaw(raw: Buffer): OffsiteVerifyKey {
  if (raw.length !== 32) throw new OffsiteSignError('A verify key is 32 bytes.');
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw new OffsiteSignError('The verify key is not usable.');
  }
  const fingerprint = verifyFingerprintOf(raw);
  return {
    raw: Buffer.from(raw),
    keyObject,
    fingerprint,
    fingerprintText: groups(fingerprint),
    text: `${VERIFY_KEY_PREFIX}${Buffer.concat([raw, verifyCheck(raw)]).toString('base64url')}`,
  };
}

const B64URL = /^[A-Za-z0-9_-]{48}$/;

/**
 * Parse the text form of a verify key. White space anywhere is
 * ignored. Errors are plain sentences and never repeat the input.
 */
export function parseVerifyKey(input: string): OffsiteVerifyKey {
  if (input.length > 400) throw new OffsiteSignError('That is too long to be a verify key.');
  let text = '';
  for (const ch of input) if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') text += ch;
  if (!text.startsWith(VERIFY_KEY_PREFIX)) {
    throw new OffsiteSignError(
      'This is not a GratisGIS verify key. It starts with ggver1: and is shown on Admin, Backup.',
    );
  }
  const body = text.slice(VERIFY_KEY_PREFIX.length);
  if (!B64URL.test(body)) {
    throw new OffsiteSignError('The verify key is the wrong length. Copy the whole line again.');
  }
  const bytes = Buffer.from(body, 'base64url');
  const raw = bytes.subarray(0, 32);
  if (!timingSafeEqual(bytes.subarray(32), verifyCheck(raw))) {
    throw new OffsiteSignError(
      'The verify key has a typo: its checksum does not match. Copy the whole line again.',
    );
  }
  return verifyKeyFromRaw(Buffer.from(raw));
}

export function signingKeyFromSeed(seed: Buffer): OffsiteSigningKey {
  if (seed.length !== 32) throw new OffsiteSignError('The signing key is damaged.');
  const keyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const x = Buffer.from(
    (createPublicKey(keyObject).export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return { seed: Buffer.from(seed), keyObject, verifyKey: verifyKeyFromRaw(x) };
}

export function generateSigningKey(): OffsiteSigningKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const d = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  return signingKeyFromSeed(d);
}

// ---------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------

export const ARCHIVE_FIELDS = [
  'kind',
  'format',
  'install',
  'prefix',
  'name',
  'bytes',
  'sha256',
  'key',
  'created',
] as const;

export const MIRROR_FIELDS = [
  'kind',
  'format',
  'install',
  'prefix',
  'run',
  'created',
  'key',
  'dump.name',
  'dump.bytes',
  'dump.sha256',
  'manifest.name',
  'manifest.bytes',
  'manifest.sha256',
  'index.name',
  'index.bytes',
  'index.sha256',
  'index.files',
] as const;

export type ArchiveManifest = Record<Exclude<(typeof ARCHIVE_FIELDS)[number], 'kind'>, string> & {
  kind: 'archive';
};
export type MirrorManifest = Record<Exclude<(typeof MIRROR_FIELDS)[number], 'kind'>, string> & {
  kind: 'mirror';
};
export type SignedManifest = ArchiveManifest | MirrorManifest;

function isHex(s: string, n: number): boolean {
  if (s.length !== n) return false;
  for (const c of s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

function isDecimal(s: string): boolean {
  if (s.length === 0 || s.length > 16) return false;
  if (s.length > 1 && s[0] === '0') return false;
  for (const c of s) if (c < '0' || c > '9') return false;
  return Number.isSafeInteger(Number(s));
}

function isPathPart(s: string): boolean {
  if (s.length === 0 || s === '.' || s === '..') return false;
  for (const c of s) {
    const ok =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '.' ||
      c === '_' ||
      c === '-';
    if (!ok) return false;
  }
  return true;
}

/** A bucket folder as the portal writes it: plain parts, ending in "/". */
export function isSignedPrefix(s: string): boolean {
  if (s.length < 2 || s.length > 200 || !s.endsWith('/')) return false;
  return s.slice(0, -1).split('/').every(isPathPart);
}

/** An object name under the folder: plain parts joined by "/". */
function isObjectName(s: string): boolean {
  if (s.length === 0 || s.length > 300) return false;
  return s.split('/').every(isPathPart);
}

function isUuid(s: string): boolean {
  if (s.length !== 36) return false;
  const parts = s.split('-');
  return parts.length === 5 && [8, 4, 4, 4, 12].every((n, i) => isHex(parts[i]!, n));
}

function isFingerprintText(s: string): boolean {
  const parts = s.split('-');
  return parts.length === 8 && parts.every((p) => isHex(p, 4));
}

function isTime(s: string): boolean {
  if (s.length !== 24 || !s.endsWith('Z')) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

function isRunName(s: string): boolean {
  // <YYYY-MM-DD>T<HH-MM-SS-mmm>-<8 hex>
  if (s.length !== 32 || s[10] !== 'T') return false;
  const digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
  const dashes = [4, 7, 13, 16, 19, 23];
  return (
    digits.every((i) => s[i]! >= '0' && s[i]! <= '9') &&
    dashes.every((i) => s[i] === '-') &&
    isHex(s.slice(24), 8)
  );
}

function checkField(kind: string, field: string, value: string): boolean {
  if (field === 'kind') return value === kind;
  if (field === 'format') return value === 'GROF1';
  if (field === 'install') return isUuid(value);
  if (field === 'prefix') return isSignedPrefix(value);
  if (field === 'run') return isRunName(value);
  if (field === 'key') return isFingerprintText(value);
  if (field === 'created') return isTime(value);
  if (field === 'name' || field.endsWith('.name')) return isObjectName(value);
  if (field === 'bytes' || field.endsWith('.bytes') || field === 'index.files') {
    return isDecimal(value);
  }
  if (field === 'sha256' || field.endsWith('.sha256')) return isHex(value, 64);
  return false;
}

function fieldsOf(kind: string): readonly string[] | null {
  if (kind === 'archive') return ARCHIVE_FIELDS;
  if (kind === 'mirror') return MIRROR_FIELDS;
  return null;
}

/** The canonical bytes of a manifest. Throws on a value outside its rule. */
export function manifestBytes(m: SignedManifest): Buffer {
  const fields = fieldsOf(m.kind);
  if (!fields) throw new OffsiteSignError('Unknown manifest kind.');
  const keys = Object.keys(m);
  if (keys.length !== fields.length || !fields.every((f) => keys.includes(f))) {
    throw new OffsiteSignError('The manifest has the wrong fields.');
  }
  let text = `${SIGNED_HEADER}\n`;
  for (const f of fields) {
    const v = (m as Record<string, string>)[f]!;
    if (typeof v !== 'string' || !checkField(m.kind, f, v)) {
      throw new OffsiteSignError(`The manifest field ${f} is not valid.`);
    }
    text += `${f}=${v}\n`;
  }
  return Buffer.from(text, 'utf8');
}

/** Parse canonical manifest bytes. Null when they are not exactly canonical. */
export function parseManifest(text: string): SignedManifest | null {
  if (text.length > MAX_MANIFEST || !text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== SIGNED_HEADER || lines.length < 2) return null;
  const kindLine = lines[1]!;
  const kind = kindLine.startsWith('kind=') ? kindLine.slice(5) : '';
  const fields = fieldsOf(kind);
  if (!fields || lines.length !== fields.length + 1) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 1) {
    const line = lines[i + 1]!;
    const f = fields[i]!;
    if (!line.startsWith(`${f}=`)) return null;
    const v = line.slice(f.length + 1);
    if (!checkField(kind, f, v)) return null;
    out[f] = v;
  }
  // Belt and braces: the bytes must be what manifestBytes writes.
  if (manifestBytes(out as SignedManifest).toString('utf8') !== text) return null;
  return out as SignedManifest;
}

/** What a sidecar or done marker carries. Plain JSON, nothing secret. */
export interface SignatureBlock {
  version: number;
  /** The canonical manifest text, exactly the signed bytes. */
  manifest: string;
  /** Ed25519 signature, base64url, 86 characters. */
  value: string;
  /** Fingerprint of the verify key that checks it. */
  verifyKey: string;
}

export function signManifest(m: SignedManifest, key: OffsiteSigningKey): SignatureBlock {
  const bytes = manifestBytes(m);
  return {
    version: SIGNATURE_VERSION,
    manifest: bytes.toString('utf8'),
    value: edSign(null, bytes, key.keyObject).toString('base64url'),
    verifyKey: key.verifyKey.fingerprintText,
  };
}

/**
 * How a copy stands:
 * - verified: signed by a trusted verify key, and the signed manifest
 *   matches where the copy was found (folder, name, size, kind).
 * - unsigned: no signature at all (copies made before signing existed).
 * - untrusted: signed by a key that is not in the trusted list.
 * - foreign: verified, but made by a portal install id not expected
 *   for this folder.
 * - bad: a signature that does not verify, a damaged block, or a
 *   signed manifest that does not match the copy.
 */
export type CopyTrust = 'verified' | 'unsigned' | 'untrusted' | 'foreign' | 'bad';

export interface CopyCheck {
  trust: CopyTrust;
  manifest: SignedManifest | null;
  /** Fingerprint of the verify key named by the signature, if any. */
  signer: string | null;
  /** A plain sentence for anything but verified. */
  reason: string | null;
}

export interface ExpectedCopy {
  kind: 'archive' | 'mirror';
  prefix: string;
  /** archive: the object name under the folder; mirror: the run folder name. */
  name: string;
  /** Size in the bucket listing, when known (archive). */
  bytes?: number | null;
  /** Install ids this folder is expected to hold copies from. Empty: any. */
  installIds?: readonly string[];
}

function asBlock(raw: unknown): SignatureBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (
    b.version !== SIGNATURE_VERSION ||
    typeof b.manifest !== 'string' ||
    typeof b.value !== 'string' ||
    typeof b.verifyKey !== 'string'
  ) {
    return null;
  }
  return b as unknown as SignatureBlock;
}

/**
 * Check the signature block of a sidecar or done marker (the parsed
 * JSON object) against the trusted verify keys and where the copy was
 * found. Never throws on bad input.
 */
export function checkSignature(
  sidecar: unknown,
  trusted: readonly OffsiteVerifyKey[],
  expected: ExpectedCopy,
): CopyCheck {
  const raw =
    sidecar && typeof sidecar === 'object' ? (sidecar as Record<string, unknown>).signature : null;
  if (raw === undefined || raw === null) {
    return { trust: 'unsigned', manifest: null, signer: null, reason: 'This copy is not signed.' };
  }
  const block = asBlock(raw);
  if (!block) {
    return {
      trust: 'bad',
      manifest: null,
      signer: null,
      reason: 'The signature block is damaged or from an unknown version.',
    };
  }
  const signer = isFingerprintText(block.verifyKey) ? block.verifyKey : null;
  const m = parseManifest(block.manifest);
  if (!m || !signer) {
    return { trust: 'bad', manifest: null, signer, reason: 'The signed manifest is not valid.' };
  }
  const key = trusted.find((k) => k.fingerprintText === signer);
  if (!key) {
    return {
      trust: 'untrusted',
      manifest: m,
      signer,
      reason: `It claims the verify key ${signer}, which is not in the key file, so that claim is not checked.`,
    };
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(block.value, 'base64url');
  } catch {
    sig = Buffer.alloc(0);
  }
  let ok = false;
  if (sig.length === 64) {
    try {
      ok = edVerify(null, Buffer.from(block.manifest, 'utf8'), key.keyObject, sig);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return { trust: 'bad', manifest: null, signer, reason: 'The signature does not verify.' };
  }
  const mismatch = (what: string): CopyCheck => ({
    trust: 'bad',
    manifest: m,
    signer,
    reason: `The signature is for another copy: the ${what} does not match.`,
  });
  if (m.kind !== expected.kind) return mismatch('kind');
  if (m.prefix !== expected.prefix) return mismatch('folder');
  if (m.kind === 'archive') {
    if (m.name !== expected.name) return mismatch('name');
    if (
      expected.bytes !== undefined &&
      expected.bytes !== null &&
      Number(m.bytes) !== expected.bytes
    ) {
      return mismatch('size');
    }
  } else {
    const mm = m;
    if (mm.run !== expected.name) return mismatch('run');
    const folder = `mirror/runs/${mm.run}/`;
    if (
      mm['dump.name'] !== `${folder}database.dump.enc` ||
      mm['manifest.name'] !== `${folder}manifest.json.enc` ||
      mm['index.name'] !== `${folder}objects.jsonl.enc`
    ) {
      return mismatch('object names');
    }
  }
  if (
    expected.installIds &&
    expected.installIds.length > 0 &&
    !expected.installIds.includes(m.install)
  ) {
    return {
      trust: 'foreign',
      manifest: m,
      signer,
      reason: `Signed for the portal install ${m.install.slice(0, 8)}, which is not the one this folder belongs to.`,
    };
  }
  return { trust: 'verified', manifest: m, signer, reason: null };
}

/**
 * How retention on the server counts a copy, from its check: a copy
 * that is not signed counts as this portal's own older copy (legacy)
 * only when its sidecar names this portal's install id.
 */
export function artifactTrust(
  check: CopyCheck,
  sidecar: unknown,
  ownInstallId: string | null,
): ArtifactTrust {
  if (check.trust === 'verified') return 'verified';
  if (check.trust === 'unsigned') {
    const id =
      sidecar && typeof sidecar === 'object'
        ? (sidecar as Record<string, unknown>).installId
        : undefined;
    return ownInstallId !== null && id === ownInstallId ? 'legacy' : 'unsigned';
  }
  return 'bad';
}
