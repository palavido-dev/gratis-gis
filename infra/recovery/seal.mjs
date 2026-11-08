// SPDX-License-Identifier: AGPL-3.0-or-later
// Streaming AES-256-GCM seal for a recovery bundle. The passphrase is
// read from a file. It is not an argument value and it is not printed.
//
//   node seal.mjs enc  passphrase-file plain cipher
//   node seal.mjs dec  passphrase-file cipher plain
//
// Format GRCV2 (chunked, so size is bounded only by the disk):
//
//   header  "GRCV2\n" | logN u8 | r u8 | p u8 | chunkLog2 u8 | salt[16] | iv[12]
//   records ciphertext[<= chunk] | tag[16], repeated, at least one
//
// The key is scrypt(passphrase, salt). Record i uses nonce
// iv XOR be64(i) in the last 8 bytes, and its AAD is
// header | be64(i) | final u8, so a reordered, dropped, or truncated
// record fails. A plaintext of N bytes always gives ceil(N / chunk)
// records, or one empty final record when N is 0.
//
// enc writes to a new file and refuses to replace one. dec writes
// plaintext only inside a fresh 0700 directory beside the output and
// renames it into place after every record has verified. On any
// failure that directory is removed and the output does not appear.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAGIC = Buffer.from('GRCV2\n');
const HEADER_LEN = MAGIC.length + 4 + 16 + 12;
const TAG_LEN = 16;
const LOG_N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const CHUNK_LOG2 = 20;

function die(message, code = 1) {
  process.stderr.write(`recovery: ${message}\n`);
  process.exit(code);
}

function deriveKey(pass, salt, logN, r, p) {
  // scrypt needs 128 * N * r bytes; allow twice that.
  const maxmem = 256 * (2 ** logN) * r;
  return scryptSync(pass, salt, 32, { N: 2 ** logN, r, p, maxmem });
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

async function readExactly(fh, buf, length, position) {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

async function encrypt(pass, inPath, outPath) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([LOG_N, SCRYPT_R, SCRYPT_P, CHUNK_LOG2]),
    salt,
    iv,
  ]);
  const key = deriveKey(pass, salt, LOG_N, SCRYPT_R, SCRYPT_P);
  const chunk = 2 ** CHUNK_LOG2;
  const input = await open(inPath, 'r');
  let output;
  try {
    output = await open(outPath, 'wx', 0o600);
  } catch (err) {
    await input.close();
    throw err;
  }
  try {
    const size = (await input.stat()).size;
    const records = Math.max(1, Math.ceil(size / chunk));
    const buf = Buffer.alloc(chunk);
    await output.write(header);
    for (let i = 0; i < records; i += 1) {
      const want = Math.min(chunk, size - i * chunk);
      const got = await readExactly(input, buf, want, i * chunk);
      if (got !== want) throw new Error('input changed while it was sealed');
      const final = i === records - 1;
      const cipher = createCipheriv('aes-256-gcm', key, nonceFor(iv, i));
      cipher.setAAD(aadFor(header, i, final));
      const body = Buffer.concat([cipher.update(buf.subarray(0, got)), cipher.final()]);
      await output.write(Buffer.concat([body, cipher.getAuthTag()]));
    }
    if ((await input.stat()).size !== size) throw new Error('input changed while it was sealed');
    await output.sync();
    await output.close();
    output = null;
  } catch (err) {
    if (output) await output.close().catch(() => {});
    try {
      unlinkSync(outPath);
    } catch {
      // nothing was created
    }
    throw err;
  } finally {
    await input.close();
  }
}

async function decrypt(pass, inPath, outPath) {
  const input = await open(inPath, 'r');
  // mkdtemp creates the directory 0700.
  const staging = mkdtempSync(join(dirname(outPath), '.unseal-'));
  const tmpPath = join(staging, basename(outPath));
  let output;
  try {
    const size = (await input.stat()).size;
    const header = Buffer.alloc(HEADER_LEN);
    if (
      size < HEADER_LEN + TAG_LEN ||
      (await readExactly(input, header, HEADER_LEN, 0)) !== HEADER_LEN ||
      !header.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      throw new Error('bundle is not a sealed recovery archive');
    }
    const [logN, r, p, chunkLog2] = header.subarray(MAGIC.length, MAGIC.length + 4);
    if (logN < 14 || logN > 22 || r < 1 || r > 16 || p < 1 || p > 4 || chunkLog2 < 12 || chunkLog2 > 26) {
      throw new Error('bundle header has unsupported parameters');
    }
    const salt = header.subarray(MAGIC.length + 4, MAGIC.length + 20);
    const iv = header.subarray(MAGIC.length + 20, HEADER_LEN);
    const key = deriveKey(pass, salt, logN, r, p);
    const chunk = 2 ** chunkLog2;
    const record = chunk + TAG_LEN;
    const body = size - HEADER_LEN;
    const records = Math.ceil(body / record);
    const lastLen = body - (records - 1) * record;
    if (records < 1 || lastLen < TAG_LEN) throw new Error('bundle is truncated');
    output = await open(tmpPath, 'wx', 0o600);
    const buf = Buffer.alloc(record);
    for (let i = 0; i < records; i += 1) {
      const final = i === records - 1;
      const len = final ? lastLen : record;
      const pos = HEADER_LEN + i * record;
      if ((await readExactly(input, buf, len, pos)) !== len) throw new Error('bundle is truncated');
      const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(iv, i));
      decipher.setAAD(aadFor(header, i, final));
      decipher.setAuthTag(buf.subarray(len - TAG_LEN, len));
      let plain;
      try {
        plain = Buffer.concat([decipher.update(buf.subarray(0, len - TAG_LEN)), decipher.final()]);
      } catch {
        throw new Error('authenticated decrypt failed');
      }
      await output.write(plain);
    }
    await output.sync();
    await output.close();
    output = null;
    renameSync(tmpPath, outPath);
  } finally {
    if (output) await output.close().catch(() => {});
    await input.close();
    rmSync(staging, { recursive: true, force: true });
  }
}

const [mode, passPath, inPath, outPath] = process.argv.slice(2);
if (!mode || !passPath || !inPath || !outPath) die('usage: seal.mjs enc|dec passphrase-file in out', 2);
const pass = readFileSync(passPath);
if (pass.length < 16) die('passphrase file is too short');

try {
  if (mode === 'enc') await encrypt(pass, inPath, outPath);
  else if (mode === 'dec') await decrypt(pass, inPath, outPath);
  else die('mode must be enc or dec', 2);
} catch (err) {
  const msg = err && typeof err.message === 'string' ? err.message : 'seal failed';
  // Messages above are ours; an fs error names a path, never key bytes.
  die(msg.replace(/\s+/g, ' ').slice(0, 300));
}
