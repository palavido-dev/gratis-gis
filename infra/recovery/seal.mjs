// SPDX-License-Identifier: AGPL-3.0-or-later
// AES-256-GCM seal for a recovery bundle. The passphrase is read from
// a file. It is not an argument value and it is not printed.
//
//   node seal.mjs enc  passphrase-file plain cipher
//   node seal.mjs dec  passphrase-file cipher plain
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from('GRCV1\n');
const [mode, passPath, inPath, outPath] = process.argv.slice(2);
if (!mode || !passPath || !inPath || !outPath) process.exit(2);

const pass = readFileSync(passPath);
if (pass.length < 16) {
  process.stderr.write('recovery: passphrase file is too short\n');
  process.exit(1);
}
const key = scryptSync(pass, 'gratis-recovery-v1', 32);

if (mode === 'enc') {
  const plain = readFileSync(inPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(outPath, Buffer.concat([MAGIC, iv, body, tag]), { mode: 0o600 });
} else if (mode === 'dec') {
  const blob = readFileSync(inPath);
  if (
    blob.length < MAGIC.length + 12 + 16 ||
    !blob.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    process.stderr.write('recovery: bundle is not a sealed recovery archive\n');
    process.exit(1);
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(MAGIC.length + 12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    process.stderr.write('recovery: authenticated decrypt failed\n');
    process.exit(1);
  }
  writeFileSync(outPath, plain, { mode: 0o600 });
} else {
  process.exit(2);
}
