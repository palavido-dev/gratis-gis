// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline rekey of credentials encrypted by credential-cipher.ts.
 * Ciphertext stays base64(ciphertext || 16-byte tag). There is no
 * version prefix. The keyring (old key, then new key) is written
 * before the transaction. A crash before COMMIT leaves the old rows.
 * After COMMIT, a process started with the new env key, or with the
 * old key plus GRATIS_CREDENTIAL_KEYRING, can decrypt.
 *
 * The script refuses while a portal-api or portal-worker process is
 * visible. It does not stop those processes itself.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

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
    ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decrypt(ciphertext, iv, aad, key) {
  const ivBuf = Buffer.from(iv, 'base64');
  const combined = Buffer.from(ciphertext, 'base64');
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

export function writersStillRunning(lines) {
  return lines.some((line) => {
    if (/jest|rekey\.test|rekey-credentials|decrypt-check/.test(line)) return false;
    return /(?:^|\s)(portal-api|portal-worker)(?:\s|$)/.test(line) || /dist\/main\.js/.test(line);
  });
}

export function runningWriterLines() {
  const lines = [];
  try {
    lines.push(
      ...execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n'),
    );
  } catch {
    /* docker is not the only way a replica runs */
  }
  try {
    lines.push(...execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n'));
  } catch {
    /* ps unavailable */
  }
  return lines;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

async function rewrite(client, sql, params, plain, aad, oldKey, newKey) {
  const next = encrypt(plain, aad, newKey);
  if (decrypt(next.ciphertext, next.iv, aad, newKey) !== plain) {
    throw new Error('verify failed');
  }
  await client.query(sql, [...params, next.ciphertext, next.iv]);
}

export async function rekeyDatabase(options) {
  const oldKey = readKeyFile(options.oldKeyFile);
  const newKey = readKeyFile(options.newKeyFile);
  if (!options.writersStopped) {
    throw new Error('Pass --writers-stopped only after every API and worker replica is stopped.');
  }
  if (!readFileSync(options.maintenanceFile, 'utf8').trim()) {
    throw new Error('The maintenance file is empty. Turn maintenance on and stop writers first.');
  }
  const lines = options.writerLines ?? runningWriterLines();
  if (writersStillRunning(lines)) {
    throw new Error('A portal-api or portal-worker process is still running. Stop every replica before rekey.');
  }
  mkdirSync(options.sealDir, { recursive: true, mode: 0o700 });
  writeAtomic(`${options.sealDir}/old.key`, `${oldKey.toString('base64')}\n`);
  writeAtomic(`${options.sealDir}/new.key`, `${newKey.toString('base64')}\n`);
  writeAtomic(options.keyringFile, `${oldKey.toString('base64')}\n${newKey.toString('base64')}\n`);
  if (options.fault === 'after-keyring') return { committed: false, fault: 'after-keyring' };
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const creds = await client.query(
      'SELECT id, item_id, encrypted_payload, iv FROM item_credential',
    );
    for (const row of creds.rows) {
      const plain = decrypt(row.encrypted_payload, row.iv, row.item_id, oldKey);
      await rewrite(
        client,
        'UPDATE item_credential SET encrypted_payload = $2, iv = $3 WHERE id = $1',
        [row.id],
        plain,
        row.item_id,
        oldKey,
        newKey,
      );
    }
    const providers = await client.query(
      'SELECT org_id, encrypted_secret, encrypted_secret_iv FROM org_ai_provider',
    );
    for (const row of providers.rows) {
      const aad = `ai-provider:${row.org_id}`;
      const plain = decrypt(row.encrypted_secret, row.encrypted_secret_iv, aad, oldKey);
      await rewrite(
        client,
        'UPDATE org_ai_provider SET encrypted_secret = $2, encrypted_secret_iv = $3 WHERE org_id = $1',
        [row.org_id],
        plain,
        aad,
        oldKey,
        newKey,
      );
    }
    const settings = await client.query(
      `SELECT key, encrypted_secret, encrypted_secret_iv FROM system_setting
       WHERE encrypted_secret IS NOT NULL`,
    );
    for (const row of settings.rows) {
      const plain = decrypt(row.encrypted_secret, row.encrypted_secret_iv, row.key, oldKey);
      await rewrite(
        client,
        'UPDATE system_setting SET encrypted_secret = $2, encrypted_secret_iv = $3 WHERE key = $1',
        [row.key],
        plain,
        row.key,
        oldKey,
        newKey,
      );
    }
    if (options.fault === 'before-commit') throw new Error('fault before commit');
    if (options.fault === 'pause-before-commit') {
      writeFileSync(options.readyFile, 'ready\n');
      await new Promise(() => undefined);
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
  return { committed: true };
}

const isDirect = process.argv[1]?.endsWith('rekey-credentials.mjs');
if (isDirect && process.env.REKEY_RUN === '1') {
  await rekeyDatabase({
    databaseUrl: process.env.DATABASE_URL,
    oldKeyFile: process.env.REKEY_OLD,
    newKeyFile: process.env.REKEY_NEW,
    keyringFile: process.env.REKEY_KEYRING,
    sealDir: process.env.REKEY_SEAL,
    maintenanceFile: process.env.REKEY_MAINTENANCE,
    envFile: process.env.REKEY_ENV || undefined,
    writersStopped: true,
    fault: process.env.REKEY_FAULT || undefined,
    readyFile: process.env.REKEY_READY || undefined,
  }).catch((err) => {
    const message = err instanceof Error ? err.message : 'rekey failed';
    console.error(message.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://REDACTED'));
    process.exit(1);
  });
}
