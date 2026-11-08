// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { decrypt, encrypt, rekeyDatabase, writersStillRunning } from './rekey-credentials.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pg = createRequire(new URL('../../apps/portal-api/package.json', import.meta.url))('pg');

assert.equal(writersStillRunning(['portal-api', 'node dist/main.js']), true);
assert.equal(writersStillRunning(['jest src/forms/forms.service.spec.ts', 'gg-combined-pg']), false);

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const org = '33333333-3333-4333-8333-333333333331';
const user = '33333333-3333-4333-8333-333333333332';
const item = '33333333-3333-4333-8333-333333333333';
const credPlain = 'arcgis-token';
const aiPlain = 'sk-test';
const smtpPlain = 'smtp-secret';
const cred = encrypt(credPlain, item, oldKey);
const ai = encrypt(aiPlain, `ai-provider:${org}`, oldKey);
const smtp = encrypt(smtpPlain, 'smtp', oldKey);

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DELETE FROM item_credential WHERE item_id = $1', [item]);
await client.query('DELETE FROM org_ai_provider WHERE org_id = $1', [org]);
await client.query(`DELETE FROM system_setting WHERE key = 'smtp'`);
await client.query('DELETE FROM item WHERE id = $1', [item]);
await client.query('DELETE FROM "user" WHERE id = $1', [user]);
await client.query('DELETE FROM organization WHERE id = $1', [org]);
await client.query(
  `INSERT INTO organization (id, slug, name) VALUES ($1, 'rekey-org', 'Rekey')`,
  [org],
);
await client.query(
  `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
   VALUES ($1, $2, 'rekey-user', 'rekey@example.test', 'Rekey User', 'admin')`,
  [user, org],
);
await client.query(
  `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
   VALUES ($1, $2, $3, 'arcgis-service', 'Upstream', '{}'::jsonb, now())`,
  [item, org, user],
);
await client.query(
  `INSERT INTO item_credential (item_id, auth_kind, encrypted_payload, iv, updated_by)
   VALUES ($1, 'bearer', $2, $3, $4)`,
  [item, cred.ciphertext, cred.iv, user],
);
await client.query(
  `INSERT INTO org_ai_provider (org_id, provider, model, encrypted_secret, encrypted_secret_iv, updated_by)
   VALUES ($1, 'openai', 'gpt', $2, $3, $4)`,
  [org, ai.ciphertext, ai.iv, user],
);
await client.query(
  `INSERT INTO system_setting (key, value, encrypted_secret, encrypted_secret_iv, updated_at)
   VALUES ('smtp', '{}'::jsonb, $1, $2, now())`,
  [smtp.ciphertext, smtp.iv],
);
await client.end();

const dir = mkdtempSync(join(tmpdir(), 'gg-rekey-'));
const oldFile = join(dir, 'old.key');
const newFile = join(dir, 'new.key');
const maintenance = join(dir, 'maintenance');
const envFile = join(dir, 'env');
writeFileSync(oldFile, `${oldKey.toString('base64')}\n`);
writeFileSync(newFile, `${newKey.toString('base64')}\n`);
writeFileSync(maintenance, 'on\n');
writeFileSync(envFile, 'CREDENTIAL_ENCRYPTION_KEY=placeholder\n');
const base = {
  databaseUrl: url,
  oldKeyFile: oldFile,
  newKeyFile: newFile,
  maintenanceFile: maintenance,
  writersStopped: true,
  writerLines: ['gg-combined-pg'],
};

await assert.rejects(
  () => rekeyDatabase({
    ...base,
    keyringFile: join(dir, 'ring-fault'),
    sealDir: join(dir, 'seal-fault'),
    fault: 'before-commit',
  }),
  /fault before commit/,
);

const pauseReady = join(dir, 'pause-ready');
const child = spawn(process.execPath, [new URL('./rekey-credentials.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    REKEY_RUN: '1',
    REKEY_OLD: oldFile,
    REKEY_NEW: newFile,
    REKEY_KEYRING: join(dir, 'ring-pause'),
    REKEY_SEAL: join(dir, 'seal-pause'),
    REKEY_MAINTENANCE: maintenance,
    REKEY_FAULT: 'pause-before-commit',
    REKEY_READY: pauseReady,
  },
  stdio: 'ignore',
});
for (let i = 0; i < 50 && !exists(pauseReady); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.equal(exists(pauseReady), true);
process.kill(child.pid, 'SIGKILL');
await new Promise((resolve) => child.on('exit', resolve));

const still = new pg.Client({ connectionString: url });
await still.connect();
const before = await still.query(
  'SELECT encrypted_payload, iv FROM item_credential WHERE item_id = $1',
  [item],
);
assert.equal(decrypt(before.rows[0].encrypted_payload, before.rows[0].iv, item, oldKey), credPlain);
await still.end();

await rekeyDatabase({
  ...base,
  keyringFile: join(dir, 'ring-done'),
  sealDir: join(dir, 'seal-done'),
  envFile,
});
const done = new pg.Client({ connectionString: url });
await done.connect();
const row = await done.query(
  'SELECT encrypted_payload, iv FROM item_credential WHERE item_id = $1',
  [item],
);
const aiRow = await done.query(
  'SELECT encrypted_secret, encrypted_secret_iv FROM org_ai_provider WHERE org_id = $1',
  [org],
);
const smtpRow = await done.query(
  `SELECT encrypted_secret, encrypted_secret_iv FROM system_setting WHERE key = 'smtp'`,
);
await done.end();
assert.equal(decrypt(row.rows[0].encrypted_payload, row.rows[0].iv, item, newKey), credPlain);
assert.throws(() => decrypt(row.rows[0].encrypted_payload, row.rows[0].iv, item, oldKey));
assert.equal(
  decrypt(aiRow.rows[0].encrypted_secret, aiRow.rows[0].encrypted_secret_iv, `ai-provider:${org}`, newKey),
  aiPlain,
);
assert.equal(
  decrypt(smtpRow.rows[0].encrypted_secret, smtpRow.rows[0].encrypted_secret_iv, 'smtp', newKey),
  smtpPlain,
);
const envText = readFileSync(envFile, 'utf8');
assert.equal(envText.includes(newKey.toString('base64')), true);
assert.equal(envText.includes(oldKey.toString('base64')), false);

const restarted = spawn(process.execPath, [
  '--experimental-strip-types',
  new URL('./decrypt-check.ts', import.meta.url).pathname,
], {
  env: {
    CREDENTIAL_ENCRYPTION_KEY: newKey.toString('base64'),
    CHECK_CIPHERTEXT: row.rows[0].encrypted_payload,
    CHECK_IV: row.rows[0].iv,
    CHECK_AAD: item,
    CHECK_EXPECT: credPlain,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = await new Promise((resolve, reject) => {
  let text = '';
  restarted.stdout.on('data', (chunk) => {
    text += chunk;
  });
  restarted.on('exit', (code) => {
    if (code === 0) resolve(text.trim());
    else reject(new Error(`restart decrypt exited ${code}`));
  });
});
assert.equal(out, 'decrypt-ok');

await clientCleanup();
console.log('offline rekey ok');

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function clientCleanup() {
  const end = new pg.Client({ connectionString: url });
  await end.connect();
  await end.query('DELETE FROM item_credential WHERE item_id = $1', [item]);
  await end.query('DELETE FROM org_ai_provider WHERE org_id = $1', [org]);
  await end.query(`DELETE FROM system_setting WHERE key = 'smtp'`);
  await end.query('DELETE FROM item WHERE id = $1', [item]);
  await end.query('DELETE FROM "user" WHERE id = $1', [user]);
  await end.query('DELETE FROM organization WHERE id = $1', [org]);
  await end.end();
}
