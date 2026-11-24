// SPDX-License-Identifier: AGPL-3.0-or-later
// The off-site backup key tool. Runs with Node.js 20 or newer and
// nothing else, on your own computer: copy this one file anywhere.
//
//   node offsite-key.mjs generate my-portal.ggkey
//   node offsite-key.mjs public my-portal.ggkey
//   node offsite-key.mjs fingerprint ggpub1:... | ggver1:...
//   node offsite-key.mjs trust my-portal.ggkey new.ggkey ggver1:... [ggver1:...]
//   node offsite-key.mjs verify my-portal.ggkey copy.enc.json [copy.enc]
//   node offsite-key.mjs decrypt my-portal.ggkey in.enc out [--sidecar in.enc.json]
//   node offsite-key.mjs encrypt ggpub1:... in out
//
// generate makes an X25519 key pair, writes the private key to a new
// file sealed with your passphrase (GRCV2, the format of seal.mjs),
// and prints the public key and its fingerprint. Paste the public key
// into the portal (Admin, Backup, Off-site copies). The portal can then
// encrypt backups for you but can never read them. Keep the key file
// and its passphrase somewhere safe and away from the portal server:
// without both, nobody can open the off-site copies.
//
// The passphrase is asked for on the terminal, or read from
// --passphrase-file FILE, or from standard input when that is not a
// terminal and not the data. One trailing line break (\n or \r\n) is
// dropped and the text is normalised to Unicode NFC, so the same words
// typed on any system open the file.
//
// trust adds the portal's verify key (shown on Admin, Backup) to the
// key file, so a restore can check that a copy was made by your
// portal. It writes a new file sealed with the same passphrase and
// never replaces one; keep the new file and retire the old one. Earlier
// verify keys stay, so older copies still check. Do it after setting
// off-site copies up and after every signing key change.
//
// verify checks a copy's signature (in its sidecar, or a mirror run's
// done.json) against the verify keys in the key file, and with the
// copy itself also its exact size and SHA-256. decrypt with --sidecar
// checks the signature first, then reads the copy once: its size and
// SHA-256 are checked while it is decrypted into a temporary file next
// to the output, and the output file appears only when they matched
// the signed record and every record decrypted. Otherwise the
// temporary file is removed and no output is left.
//
// decrypt takes - for standard input or output. To a file, the output
// appears only after every record verified, and an existing file is
// never replaced. To standard output, bytes
// are written as they verify: if the command fails, discard them.
//
// File formats: docs/operations/offsite-backup-format.md.
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
  scryptSync,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto';
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// ---- GROF1 (backup files) ----------------------------------------
const MAGIC = Buffer.from('GROF1\n');
const KEY_ID_LEN = 16;
const WRAP_AAD_LEN = MAGIC.length + 1 + KEY_ID_LEN + 32;
const HEADER_LEN = WRAP_AAD_LEN + 48 + 12;
const TAG_LEN = 16;
const CHUNK_LOG2 = 20;
const WRAP_INFO = Buffer.from('gratisgis-offsite-v1 data key wrap');
const FP_LABEL = Buffer.from('gratisgis-offsite-key-fingerprint-v1\0');
const PUB_LABEL = Buffer.from('gratisgis-offsite-public-key-v1\0');
const SEC_LABEL = Buffer.from('gratisgis-offsite-private-key-v1\0');
const PUB_PREFIX = 'ggpub1:';
const SEC_PREFIX = 'ggsec1:';
const KIND = 'gratisgis-offsite-private-key';
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

// ---- signatures (offsite-sign.ts) ----------------------------------
const VER_PREFIX = 'ggver1:';
const VER_CHECK_LABEL = Buffer.from('gratisgis-offsite-verify-key-v1\0');
const VER_FP_LABEL = Buffer.from('gratisgis-offsite-verify-key-fingerprint-v1\0');
const SIGNED_HEADER = 'gratisgis-offsite-signed-v1';
const MAX_VERIFY_KEYS = 64;
const ARCHIVE_FIELDS = [
  'kind',
  'format',
  'install',
  'prefix',
  'name',
  'bytes',
  'sha256',
  'key',
  'created',
];
const MIRROR_FIELDS = [
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
];

// ---- GRCV2 (the sealed key file) -----------------------------------
const G_MAGIC = Buffer.from('GRCV2\n');
const G_HEADER_LEN = G_MAGIC.length + 4 + 16 + 12;
// Tests may lower the scrypt cost to the least seal.mjs accepts.
const G_LOG_N = process.env.GG_OFFSITE_KEY_TEST_LOGN === '14' ? 14 : 17;
const PASS_MIN = 16;

class Fail extends Error {}

function die(message, code = 1) {
  process.stderr.write(`offsite-key: ${message}\n`);
  process.exit(code);
}

const check4 = (label, raw) =>
  createHash('sha256').update(label).update(raw).digest().subarray(0, 4);
const fingerprintOf = (raw) =>
  createHash('sha256').update(FP_LABEL).update(raw).digest().subarray(0, KEY_ID_LEN);
const fpText = (fp) => fp.toString('hex').match(/.{4}/g).join('-');

function publicFromRaw(raw) {
  return {
    raw,
    obj: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
      format: 'jwk',
    }),
    fp: fingerprintOf(raw),
    text: PUB_PREFIX + Buffer.concat([raw, check4(PUB_LABEL, raw)]).toString('base64url'),
  };
}

function parsePublic(input) {
  const text = String(input).replace(/\s+/g, '');
  if (!text.startsWith(PUB_PREFIX))
    throw new Fail('not a GratisGIS off-site public key (it starts with ggpub1:)');
  const body = text.slice(PUB_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{48}$/.test(body)) throw new Fail('the public key is the wrong length');
  const bytes = Buffer.from(body, 'base64url');
  const raw = bytes.subarray(0, 32);
  if (!timingSafeEqual(bytes.subarray(32), check4(PUB_LABEL, raw)))
    throw new Fail('the public key checksum does not match (a typo?)');
  return publicFromRaw(Buffer.from(raw));
}

function privateFromRaw(d) {
  const obj = createPrivateKey({ key: Buffer.concat([PKCS8, d]), format: 'der', type: 'pkcs8' });
  const x = Buffer.from(createPublicKey(obj).export({ format: 'jwk' }).x, 'base64url');
  return { obj, d, pub: publicFromRaw(x) };
}

const verCheck = (raw) =>
  createHash('sha256').update(VER_CHECK_LABEL).update(raw).digest().subarray(0, 4);
const verFingerprintOf = (raw) =>
  createHash('sha256').update(VER_FP_LABEL).update(raw).digest().subarray(0, 16);

function verifyFromRaw(raw) {
  let obj;
  try {
    obj = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw new Fail('the verify key is not usable');
  }
  const fp = verFingerprintOf(raw);
  return {
    raw,
    obj,
    fp,
    fpText: fpText(fp),
    text: VER_PREFIX + Buffer.concat([raw, verCheck(raw)]).toString('base64url'),
  };
}

function parseVerify(input) {
  const text = String(input).replace(/\s/g, '');
  if (text.length > 400 || !text.startsWith(VER_PREFIX))
    throw new Fail(
      'not a GratisGIS verify key (it starts with ggver1: and is shown on Admin, Backup)',
    );
  const body = text.slice(VER_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{48}$/.test(body)) throw new Fail('the verify key is the wrong length');
  const bytes = Buffer.from(body, 'base64url');
  const raw = bytes.subarray(0, 32);
  if (!timingSafeEqual(bytes.subarray(32), verCheck(raw)))
    throw new Fail('the verify key checksum does not match (a typo?)');
  return verifyFromRaw(Buffer.from(raw));
}

// ---- signed manifests: the exact rules of offsite-sign.ts ----------
const isHex = (s, n) =>
  s.length === n && [...s].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
const isDecimal = (s) =>
  s.length > 0 &&
  s.length <= 16 &&
  !(s.length > 1 && s[0] === '0') &&
  [...s].every((c) => c >= '0' && c <= '9') &&
  Number.isSafeInteger(Number(s));
const isPathPart = (s) =>
  s.length > 0 &&
  s !== '.' &&
  s !== '..' &&
  [...s].every(
    (c) =>
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '.' ||
      c === '_' ||
      c === '-',
  );
const isPrefix = (s) =>
  s.length >= 2 &&
  s.length <= 200 &&
  s.endsWith('/') &&
  s.slice(0, -1).split('/').every(isPathPart);
const isObjectName = (s) => s.length > 0 && s.length <= 300 && s.split('/').every(isPathPart);
const isUuid = (s) => {
  const p = s.split('-');
  return s.length === 36 && p.length === 5 && [8, 4, 4, 4, 12].every((n, i) => isHex(p[i], n));
};
const isFp = (s) => {
  const p = s.split('-');
  return p.length === 8 && p.every((x) => isHex(x, 4));
};
const isTime = (s) => {
  if (s.length !== 24 || !s.endsWith('Z')) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
};
const isRun = (s) =>
  s.length === 32 &&
  s[10] === 'T' &&
  [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22].every(
    (i) => s[i] >= '0' && s[i] <= '9',
  ) &&
  [4, 7, 13, 16, 19, 23].every((i) => s[i] === '-') &&
  isHex(s.slice(24), 8);

function checkField(kind, f, v) {
  if (f === 'kind') return v === kind;
  if (f === 'format') return v === 'GROF1';
  if (f === 'install') return isUuid(v);
  if (f === 'prefix') return isPrefix(v);
  if (f === 'run') return isRun(v);
  if (f === 'key') return isFp(v);
  if (f === 'created') return isTime(v);
  if (f === 'name' || f.endsWith('.name')) return isObjectName(v);
  if (f === 'bytes' || f.endsWith('.bytes') || f === 'index.files') return isDecimal(v);
  if (f === 'sha256' || f.endsWith('.sha256')) return isHex(v, 64);
  return false;
}

/** The manifest, or null when the text is not exactly canonical. */
function parseManifest(text) {
  if (typeof text !== 'string' || text.length > 4096 || !text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== SIGNED_HEADER || lines.length < 2) return null;
  const kind = lines[1].startsWith('kind=') ? lines[1].slice(5) : '';
  const fields = kind === 'archive' ? ARCHIVE_FIELDS : kind === 'mirror' ? MIRROR_FIELDS : null;
  if (!fields || lines.length !== fields.length + 1) return null;
  const out = {};
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    const line = lines[i + 1];
    if (!line.startsWith(`${f}=`)) return null;
    const v = line.slice(f.length + 1);
    if (!checkField(kind, f, v)) return null;
    out[f] = v;
  }
  let again = `${SIGNED_HEADER}\n`;
  for (const f of fields) again += `${f}=${out[f]}\n`;
  return again === text ? out : null;
}

/**
 * Check a sidecar's (or done.json's) signature against the trusted
 * verify keys. Returns { ok, manifest, signer, reason }.
 */
function checkSidecar(j, trusted) {
  const b = j && typeof j === 'object' ? j.signature : undefined;
  if (b === undefined || b === null)
    return { ok: false, signer: null, reason: 'this copy is not signed' };
  if (
    typeof b !== 'object' ||
    b.version !== 1 ||
    typeof b.manifest !== 'string' ||
    typeof b.value !== 'string' ||
    typeof b.verifyKey !== 'string'
  )
    return {
      ok: false,
      signer: null,
      reason: 'the signature block is damaged or from an unknown version',
    };
  const signer = isFp(b.verifyKey) ? b.verifyKey : null;
  const m = parseManifest(b.manifest);
  if (!m || !signer) return { ok: false, signer, reason: 'the signed manifest is not valid' };
  const key = trusted.find((k) => k.fpText === signer);
  if (!key)
    return {
      ok: false,
      signer,
      reason: `it claims the verify key ${signer}, which is not in the key file, so that claim is not checked`,
    };
  const sig = Buffer.from(b.value, 'base64url');
  let good = false;
  if (sig.length === 64) {
    try {
      good = edVerify(null, Buffer.from(b.manifest, 'utf8'), key.obj, sig);
    } catch {
      good = false;
    }
  }
  if (!good) return { ok: false, signer, reason: 'the signature does not verify' };
  return { ok: true, manifest: m, signer, reason: null };
}

function nonceFor(iv, index) {
  const nonce = Buffer.from(iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(index));
  for (let i = 0; i < 8; i += 1) nonce[4 + i] ^= counter[i];
  return nonce;
}

function aadFor(header, index, final) {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index));
  tail[8] = final ? 1 : 0;
  return Buffer.concat([header, tail]);
}

function agree(privateKey, publicKey) {
  let shared;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    throw new Fail('the key agreement failed: the file or key is not valid');
  }
  if (shared.every((b) => b === 0))
    throw new Fail('the key agreement failed: the file or key is not valid');
  return shared;
}

const wrapKeyFor = (shared, eph, recipient) =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), WRAP_INFO, 32));

// ---- passphrases -------------------------------------------------
function normalizePassphrase(raw) {
  return String(raw)
    .replace(/\r?\n$/, '')
    .normalize('NFC');
}

function checkPassphrase(p) {
  if (p.length < PASS_MIN) throw new Fail(`the passphrase must be at least ${PASS_MIN} characters`);
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c < 32 || c === 127)
      throw new Fail('the passphrase cannot contain line breaks or control characters');
  }
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let text = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(text);
    };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Fail('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinText(limit = 4096) {
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += c.length;
    if (n > limit) throw new Fail('the passphrase on standard input is too long');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getPassphrase(opts, { confirm = false, stdinIsData = false } = {}) {
  let raw;
  if (opts.passphraseFile) {
    raw = readFileSync(opts.passphraseFile, 'utf8');
  } else if (process.stdin.isTTY) {
    raw = await promptHidden('Key file passphrase: ');
    if (confirm && (await promptHidden('Type it again: ')) !== raw)
      throw new Fail('the two passphrases do not match');
  } else if (stdinIsData) {
    throw new Fail(
      'the data comes on standard input, so give the passphrase with --passphrase-file',
    );
  } else {
    raw = await readStdinText();
  }
  const p = normalizePassphrase(raw);
  checkPassphrase(p);
  return p;
}

// ---- GRCV2, for the small key file -----------------------------------
function scryptKey(pass, salt, logN, r, p) {
  return scryptSync(Buffer.from(pass, 'utf8'), salt, 32, {
    N: 2 ** logN,
    r,
    p,
    maxmem: 256 * 2 ** logN * r,
  });
}

function grcv2Seal(plain, pass) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([G_MAGIC, Buffer.from([G_LOG_N, 8, 1, 20]), salt, iv]);
  const key = scryptKey(pass, salt, G_LOG_N, 8, 1);
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(iv, 0));
  cipher.setAAD(aadFor(header, 0, true));
  return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function grcv2Open(file, pass) {
  if (file.length < G_HEADER_LEN + TAG_LEN || !file.subarray(0, G_MAGIC.length).equals(G_MAGIC)) {
    throw new Fail('this is not a sealed GratisGIS key file');
  }
  const header = file.subarray(0, G_HEADER_LEN);
  const [logN, r, p, chunkLog2] = header.subarray(G_MAGIC.length, G_MAGIC.length + 4);
  if (logN < 14 || logN > 17 || r < 1 || r > 8 || p !== 1 || chunkLog2 < 12 || chunkLog2 > 20) {
    throw new Fail('the key file has unsupported parameters');
  }
  // A key file is one small record.
  if (file.length - G_HEADER_LEN > 2 ** chunkLog2 + TAG_LEN)
    throw new Fail('this is not a GratisGIS key file');
  const salt = header.subarray(G_MAGIC.length + 4, G_MAGIC.length + 20);
  const iv = header.subarray(G_MAGIC.length + 20, G_HEADER_LEN);
  const key = scryptKey(pass, salt, logN, r, p);
  const body = file.subarray(G_HEADER_LEN);
  const d = createDecipheriv('aes-256-gcm', key, nonceFor(iv, 0));
  d.setAAD(aadFor(header, 0, true));
  d.setAuthTag(body.subarray(body.length - TAG_LEN));
  try {
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG_LEN)), d.final()]);
  } catch {
    throw new Fail('the key file did not open: the passphrase is wrong, or the file was changed');
  }
}

function openKeyFile(path, pass) {
  const plain = grcv2Open(readFileSync(path), pass);
  let j;
  try {
    j = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Fail('the key file is damaged');
  }
  if (
    j.kind !== KIND ||
    j.version !== 1 ||
    typeof j.privateKey !== 'string' ||
    !j.privateKey.startsWith(SEC_PREFIX)
  ) {
    throw new Fail('this is not a GratisGIS off-site key file');
  }
  const bytes = Buffer.from(j.privateKey.slice(SEC_PREFIX.length), 'base64url');
  const d = bytes.subarray(0, 32);
  if (bytes.length !== 36 || !timingSafeEqual(bytes.subarray(32), check4(SEC_LABEL, d)))
    throw new Fail('the key file is damaged');
  const key = privateFromRaw(Buffer.from(d));
  if (j.publicKey && j.publicKey !== key.pub.text)
    throw new Fail('the key file is damaged: its two halves do not match');
  if (
    j.verifyKeys !== undefined &&
    (!Array.isArray(j.verifyKeys) || j.verifyKeys.length > MAX_VERIFY_KEYS)
  )
    throw new Fail('the key file is damaged: its list of verify keys is not valid');
  const verifyKeys = [];
  for (const t of j.verifyKeys ?? []) {
    let v;
    try {
      v = parseVerify(t);
    } catch {
      throw new Fail('the key file is damaged: one of its verify keys is not valid');
    }
    if (!verifyKeys.some((x) => x.fp.equals(v.fp))) verifyKeys.push(v);
  }
  return { ...key, body: j, verifyKeys };
}

// ---- streams -------------------------------------------------------
class Queue {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  push(b) {
    if (b.length) {
      this.parts.push(b);
      this.length += b.length;
    }
  }
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.parts[0];
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

async function* encryptStream(source, pub) {
  const dataKey = randomBytes(32);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const wrapKey = wrapKeyFor(agree(eph.privateKey, pub.obj), ephRaw, pub.raw);
  const prefix = Buffer.concat([MAGIC, Buffer.from([CHUNK_LOG2]), pub.fp, ephRaw]);
  const w = createCipheriv('aes-256-gcm', wrapKey, Buffer.alloc(12));
  w.setAAD(prefix);
  const iv = randomBytes(12);
  const head = Buffer.concat([prefix, w.update(dataKey), w.final(), w.getAuthTag(), iv]);
  const chunk = 2 ** CHUNK_LOG2;
  const seal = (plain, i, final) => {
    const c = createCipheriv('aes-256-gcm', dataKey, nonceFor(iv, i));
    c.setAAD(aadFor(head, i, final));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  yield head;
  const q = new Queue();
  let i = 0;
  for await (const piece of source) {
    q.push(Buffer.from(piece));
    while (q.length > chunk) yield seal(q.take(chunk), i++, false);
  }
  yield seal(q.take(q.length), i, true);
}

async function* decryptStream(source, key) {
  const q = new Queue();
  let head = null;
  let dataKey = null;
  let iv = null;
  let record = 0;
  let i = 0;
  const openRecord = (buf, final) => {
    const d = createDecipheriv('aes-256-gcm', dataKey, nonceFor(iv, i));
    d.setAAD(aadFor(head, i, final));
    d.setAuthTag(buf.subarray(buf.length - TAG_LEN));
    try {
      return Buffer.concat([d.update(buf.subarray(0, buf.length - TAG_LEN)), d.final()]);
    } catch {
      throw new Fail(
        'the encrypted file did not verify: it was changed, cut short, or has extra bytes',
      );
    }
  };
  for await (const piece of source) {
    q.push(Buffer.from(piece));
    if (!head && q.length >= HEADER_LEN) {
      head = q.take(HEADER_LEN);
      if (!head.subarray(0, MAGIC.length).equals(MAGIC))
        throw new Fail('this is not an encrypted GratisGIS off-site backup');
      const chunkLog2 = head[MAGIC.length];
      if (chunkLog2 < 12 || chunkLog2 > CHUNK_LOG2)
        throw new Fail('the encrypted file has unsupported parameters');
      let o = MAGIC.length + 1;
      const keyId = head.subarray(o, o + KEY_ID_LEN);
      o += KEY_ID_LEN;
      if (!timingSafeEqual(keyId, key.pub.fp)) {
        throw new Fail(
          `this file was encrypted for a different key (fingerprint ${fpText(keyId)}); this key is ${fpText(key.pub.fp)}`,
        );
      }
      const eph = Buffer.from(head.subarray(o, o + 32));
      o += 32;
      let ephObj;
      try {
        ephObj = createPublicKey({
          key: { kty: 'OKP', crv: 'X25519', x: eph.toString('base64url') },
          format: 'jwk',
        });
      } catch {
        throw new Fail('the key agreement failed: the file or key is not valid');
      }
      const wrapKey = wrapKeyFor(agree(key.obj, ephObj), eph, key.pub.raw);
      const w = createDecipheriv('aes-256-gcm', wrapKey, Buffer.alloc(12));
      w.setAAD(head.subarray(0, WRAP_AAD_LEN));
      w.setAuthTag(head.subarray(o + 32, o + 48));
      try {
        dataKey = Buffer.concat([w.update(head.subarray(o, o + 32)), w.final()]);
      } catch {
        throw new Fail(
          'the encrypted file did not verify: it was made for another key, or it was changed',
        );
      }
      iv = head.subarray(o + 48, HEADER_LEN);
      record = 2 ** chunkLog2 + TAG_LEN;
    }
    while (head && q.length > record) {
      yield openRecord(q.take(record), false);
      i += 1;
    }
  }
  if (!head) throw new Fail('the encrypted file is too short to be a backup');
  if (q.length < TAG_LEN) throw new Fail('the encrypted file is cut short');
  yield openRecord(q.take(q.length), true);
}

const source = (p) => (p === '-' ? process.stdin : createReadStream(p));

/**
 * Write a stream to a file only once it has all verified. Never
 * replaces a file that is already there (a typo could otherwise
 * overwrite the key file): the name is claimed first with an exclusive
 * create, and given up again if anything fails.
 */
async function writeVerified(gen, outPath) {
  if (outPath === '-') {
    for await (const b of gen) {
      if (!process.stdout.write(b)) await new Promise((r) => process.stdout.once('drain', r));
    }
    return;
  }
  let claim;
  try {
    claim = await open(outPath, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new Fail(`${outPath} already exists; give a new file name`);
    throw e;
  }
  await claim.close();
  // mkdtemp creates the directory 0700.
  const staging = mkdtempSync(join(dirname(outPath), '.offsite-key-'));
  const tmp = join(staging, basename(outPath));
  let fh;
  let done = false;
  try {
    fh = await open(tmp, 'wx', 0o600);
    for await (const b of gen) await fh.write(b);
    await fh.sync();
    await fh.close();
    fh = null;
    // Replaces only the empty file claimed above.
    renameSync(tmp, outPath);
    done = true;
  } finally {
    if (fh) await fh.close().catch(() => {});
    rmSync(staging, { recursive: true, force: true });
    if (!done) rmSync(outPath, { force: true });
  }
}

// ---- commands ------------------------------------------------------
function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--passphrase-file') {
      opts.passphraseFile = argv[i + 1];
      if (!opts.passphraseFile) throw new Fail('--passphrase-file needs a file');
      i += 1;
    } else if (a === '--sidecar') {
      opts.sidecar = argv[i + 1];
      if (!opts.sidecar) throw new Fail('--sidecar needs a file');
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Fail(`unknown option ${a}`);
    } else {
      opts.positional.push(a);
    }
  }
  return opts;
}

function printKey(pub) {
  process.stdout.write(`Public key:  ${pub.text}\nFingerprint: ${fpText(pub.fp)}\n`);
}

function printTrusted(keys) {
  if (keys.length === 0) {
    process.stdout.write(
      'Verify keys: none yet. Add the one shown on Admin, Backup with: offsite-key.mjs trust\n',
    );
    return;
  }
  for (const v of keys) process.stdout.write(`Verify key:  ${v.text}  (fingerprint ${v.fpText})\n`);
}

function readSidecar(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    throw new Fail(`${file} could not be read`);
  }
  if (buf.length > 64 * 1024) throw new Fail(`${file} is too large to be a sidecar`);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Fail(`${file} is not a sidecar (not JSON)`);
  }
}

function checkMatch(got, want) {
  if (String(got.bytes) !== want.bytes)
    throw new Fail(
      `NOT VERIFIED: the file has ${got.bytes} bytes; the signed record says ${want.bytes}`,
    );
  if (got.sha256 !== want.sha256)
    throw new Fail('NOT VERIFIED: the file does not match the SHA-256 in its signed record');
}

/**
 * The file's bytes, hashed as they are read once; fails at the end,
 * before decryption can finish, when they do not match the record.
 */
async function* readMatching(file, want) {
  const h = createHash('sha256');
  let n = 0;
  for await (const c of createReadStream(file)) {
    h.update(c);
    n += c.length;
    yield c;
  }
  checkMatch({ bytes: n, sha256: h.digest('hex') }, want);
}

/** Size and SHA-256 of a file, read as a stream. */
async function sizeAndHash(file) {
  const h = createHash('sha256');
  let n = 0;
  for await (const c of createReadStream(file)) {
    h.update(c);
    n += c.length;
  }
  return { bytes: n, sha256: h.digest('hex') };
}

/**
 * Verify a copy: the signature in its sidecar against the key file's
 * verify keys, the sidecar's own file name against the signed name,
 * and, when the copy is given, its file name, exact size and SHA-256.
 * Throws a Fail with a plain reason when anything does not match.
 */
async function verifyCopy(key, sidecarPath, copyPath, { hash = true } = {}) {
  const j = readSidecar(sidecarPath);
  const r = checkSidecar(j, key.verifyKeys);
  if (!r.ok) throw new Fail(`NOT VERIFIED: ${r.reason}`);
  const m = r.manifest;
  const sideName = basename(sidecarPath);
  if (m.kind === 'archive' && sideName !== `${basename(m.name)}.json`) {
    throw new Fail(
      `NOT VERIFIED: the sidecar is named ${sideName}; its signature is for ${basename(m.name)}`,
    );
  }
  let checked = null;
  if (copyPath) {
    const want =
      m.kind === 'archive'
        ? [{ name: m.name, bytes: m.bytes, sha256: m.sha256 }]
        : ['dump', 'manifest', 'index'].map((p) => ({
            name: m[`${p}.name`],
            bytes: m[`${p}.bytes`],
            sha256: m[`${p}.sha256`],
          }));
    const hit = want.find((w) => basename(w.name) === basename(copyPath));
    if (!hit) {
      throw new Fail(
        `NOT VERIFIED: ${basename(copyPath)} is not the file this signature is for (${want.map((w) => basename(w.name)).join(', ')})`,
      );
    }
    if (hash) checkMatch(await sizeAndHash(copyPath), hit);
    checked = hit;
  }
  return { manifest: m, signer: r.signer, checked };
}

function printVerified(v) {
  const m = v.manifest;
  process.stdout.write(
    [
      `Verified: signed by the verify key ${v.signer}`,
      `Kind:     ${m.kind}`,
      `Copy:     ${m.kind === 'archive' ? m.name : `mirror run ${m.run}`}`,
      `Folder:   ${m.prefix}`,
      `Portal:   install ${m.install}`,
      `Made:     ${m.created}`,
      `Key:      ${m.key}`,
      v.checked
        ? `File:     ${basename(v.checked.name)} matches (${v.checked.bytes} bytes, SHA-256)`
        : 'File:     not checked (give the copy too)',
    ].join('\n') + '\n',
  );
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const [a, b, c] = opts.positional;
  switch (cmd) {
    case 'generate': {
      if (!a) throw new Fail('usage: offsite-key.mjs generate KEYFILE');
      const pass = await getPassphrase(opts, { confirm: true });
      const { privateKey } = generateKeyPairSync('x25519');
      const key = privateFromRaw(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));
      const body = JSON.stringify({
        kind: KIND,
        version: 1,
        privateKey:
          SEC_PREFIX + Buffer.concat([key.d, check4(SEC_LABEL, key.d)]).toString('base64url'),
        publicKey: key.pub.text,
        fingerprint: fpText(key.pub.fp),
      });
      // 'wx': never replace an existing key file.
      writeFileSync(a, grcv2Seal(Buffer.from(body, 'utf8'), pass), { flag: 'wx', mode: 0o600 });
      printKey(key.pub);
      process.stderr.write(
        `Wrote ${a}. Keep it and its passphrase safe, away from the portal server: without both, nobody can open the off-site copies.\n`,
      );
      return;
    }
    case 'public': {
      if (!a) throw new Fail('usage: offsite-key.mjs public KEYFILE');
      const key = openKeyFile(a, await getPassphrase(opts));
      printKey(key.pub);
      printTrusted(key.verifyKeys);
      return;
    }
    case 'fingerprint': {
      if (!a) throw new Fail('usage: offsite-key.mjs fingerprint PUBLICKEY | VERIFYKEY');
      const fp = String(a).trim().startsWith(VER_PREFIX) ? parseVerify(a).fp : parsePublic(a).fp;
      process.stdout.write(`${fpText(fp)}\n`);
      return;
    }
    case 'trust': {
      const add = opts.positional.slice(2);
      if (!a || !b || add.length === 0)
        throw new Fail('usage: offsite-key.mjs trust KEYFILE NEWKEYFILE VERIFYKEY [VERIFYKEY...]');
      const parsed = add.map(parseVerify);
      const pass = await getPassphrase(opts);
      const key = openKeyFile(a, pass);
      const list = [...key.verifyKeys];
      const added = [];
      for (const v of parsed) {
        if (!list.some((x) => x.fp.equals(v.fp))) {
          list.push(v);
          added.push(v);
        }
      }
      if (list.length > MAX_VERIFY_KEYS)
        throw new Fail(`a key file holds at most ${MAX_VERIFY_KEYS} verify keys`);
      const body = JSON.stringify({ ...key.body, verifyKeys: list.map((v) => v.text) });
      // 'wx': never replace an existing file, the old key file included.
      try {
        writeFileSync(b, grcv2Seal(Buffer.from(body, 'utf8'), pass), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e && e.code === 'EEXIST') throw new Fail(`${b} already exists; give a new file name`);
        throw e;
      }
      for (const v of added) process.stdout.write(`Added verify key ${v.fpText}\n`);
      if (added.length === 0) process.stdout.write('These verify keys were already trusted.\n');
      printTrusted(list);
      process.stderr.write(
        `Wrote ${b}, sealed with the same passphrase. Check it opens (public ${b}), then keep it in place of ${a}.\n`,
      );
      return;
    }
    case 'verify': {
      if (!a || !b) throw new Fail('usage: offsite-key.mjs verify KEYFILE SIDECAR [COPY]');
      const key = openKeyFile(a, await getPassphrase(opts));
      printVerified(await verifyCopy(key, b, c));
      return;
    }
    case 'decrypt': {
      if (!a || !b || !c)
        throw new Fail('usage: offsite-key.mjs decrypt KEYFILE IN OUT [--sidecar FILE]');
      const key = openKeyFile(a, await getPassphrase(opts, { stdinIsData: b === '-' }));
      if (opts.sidecar) {
        if (b === '-' || c === '-')
          throw new Fail('with --sidecar, give the copy and the output as files, not -');
        // The signature first, before anything is decrypted. Then the
        // copy is read once: its size and SHA-256 are checked while it
        // is decrypted into a temporary file next to the output
        // (writeVerified). The output file appears only when they
        // matched the signed record and every record decrypted; the
        // temporary file is removed either way.
        const v = await verifyCopy(key, opts.sidecar, b, { hash: false });
        process.stderr.write(`Signature verified: signed by the verify key ${v.signer}.\n`);
        await writeVerified(decryptStream(readMatching(b, v.checked), key), c);
        return;
      }
      process.stderr.write(
        'Note: the signature of this copy was not checked. Give --sidecar with its .json file to check who made it.\n',
      );
      await writeVerified(decryptStream(source(b), key), c);
      return;
    }
    case 'encrypt': {
      if (!a || !b || !c) throw new Fail('usage: offsite-key.mjs encrypt PUBLICKEY IN OUT');
      await writeVerified(encryptStream(source(b), parsePublic(a)), c);
      return;
    }
    default:
      throw new Fail(
        'usage: offsite-key.mjs generate | public | fingerprint | trust | verify | decrypt | encrypt (see the top of this file)',
      );
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  const msg =
    err instanceof Fail
      ? err.message
      : err && typeof err.message === 'string'
        ? err.message
        : 'failed';
  // Messages are ours, or an fs error naming a path; never key bytes.
  die(
    msg.replace(/\s+/g, ' ').slice(0, 300),
    err instanceof Fail &&
      (err.message.startsWith('usage') || err.message.includes('unknown option'))
      ? 2
      : 1,
  );
}
