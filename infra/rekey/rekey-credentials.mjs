// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline application-credential rekey. The HTTP mutation stays absent.
 * Writers must already be stopped. The keyring (old key, then new key)
 * is written before any ciphertext change, so a crash before COMMIT
 * still opens the old rows.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(new URL('../../apps/portal-api/package.json', import.meta.url));
const pg = require('pg');

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function readKeyFile(path) {
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key file ${path} must decode to ${KEY_LENGTH} bytes.`);
  }
  return key;
}

export function encrypt(plain, aad, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: `v2:${Buffer.concat([enc, cipher.getAuthTag()]).toString('base64')}`,
    iv: iv.toString('base64'),
  };
}

export function decrypt(ciphertext, iv, aad, key) {
  const payload = ciphertext.startsWith('v2:') ? ciphertext.slice(3) : ciphertext;
  const ivBuf = Buffer.from(iv, 'base64');
  const combined = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(combined.subarray(combined.length - TAG_LENGTH));
  return Buffer.concat([
    decipher.update(combined.subarray(0, combined.length - TAG_LENGTH)),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptAny(ciphertext, iv, aad, keys) {
  let last;
  for (const key of keys) {
    try {
      return decrypt(ciphertext, iv, aad, key);
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error('no key opened the credential');
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export async function rekeyDatabase(options) {
  const oldKey = readKeyFile(options.oldKeyFile);
  const newKey = readKeyFile(options.newKeyFile);
  if (!options.writersStopped) {
    throw new Error('Refusing to rekey while writers may still be running. Pass --writers-stopped after stopping every API and worker replica.');
  }
  const maintenance = readFileSync(options.maintenanceFile, 'utf8');
  if (!maintenance.trim()) {
    throw new Error('The maintenance file is empty. Turn maintenance on and stop writers first.');
  }
  mkdirSync(options.sealDir, { recursive: true, mode: 0o700 });
  writeAtomic(`${options.sealDir}/old.key`, readFileSync(options.oldKeyFile, 'utf8').trim() + '\n');
  writeAtomic(`${options.sealDir}/new.key`, readFileSync(options.newKeyFile, 'utf8').trim() + '\n');
  writeAtomic(options.keyringFile, `${oldKey.toString('base64')}\n${newKey.toString('base64')}\n`);
  if (options.fault === 'after-keyring') {
    return { committed: false, fault: 'after-keyring' };
  }
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const creds = await client.query(
      'SELECT id, item_id, encrypted_payload, iv FROM item_credential',
    );
    for (const row of creds.rows) {
      const plain = decrypt(row.encrypted_payload, row.iv, row.item_id, oldKey);
      const next = encrypt(plain, row.item_id, newKey);
      const check = decrypt(next.ciphertext, next.iv, row.item_id, newKey);
      if (check !== plain) throw new Error('verify failed');
      await client.query(
        'UPDATE item_credential SET encrypted_payload = $2, iv = $3 WHERE id = $1',
        [row.id, next.ciphertext, next.iv],
      );
    }
    if (options.fault === 'before-commit') {
      throw new Error('fault before commit');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  if (options.envFile) {
    const text = readFileSync(options.envFile, 'utf8');
    const line = `CREDENTIAL_ENCRYPTION_KEY=${newKey.toString('base64')}`;
    const replaced = /^CREDENTIAL_ENCRYPTION_KEY=.*$/m.test(text)
      ? text.replace(/^CREDENTIAL_ENCRYPTION_KEY=.*$/m, line)
      : `${text.trim()}\n${line}\n`;
    writeAtomic(options.envFile, replaced.endsWith('\n') ? replaced : `${replaced}\n`);
  }
  return { committed: true, rows: true };
}
