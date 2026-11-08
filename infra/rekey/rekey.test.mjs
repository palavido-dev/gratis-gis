// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { decrypt, decryptAny, encrypt, rekeyDatabase } from './rekey-credentials.mjs';

const pg = createRequire(new URL('../../apps/portal-api/package.json', import.meta.url))('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const plain = 'credential-secret';
const aad = '11111111-1111-4111-8111-111111111111';
const first = encrypt(plain, aad, oldKey);
const legacy = {
  ciphertext: first.ciphertext.slice(3),
  iv: first.iv,
};

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DROP TABLE IF EXISTS item_credential');
await client.query(`CREATE TABLE item_credential (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  encrypted_payload text NOT NULL,
  iv text NOT NULL
)`);
await client.query(
  'INSERT INTO item_credential (id, item_id, encrypted_payload, iv) VALUES ($1,$2,$3,$4)',
  [aad, aad, legacy.ciphertext, legacy.iv],
);
await client.end();

const dir = mkdtempSync(join(tmpdir(), 'gg-rekey-'));
const oldFile = join(dir, 'old.key');
const newFile = join(dir, 'new.key');
const keyring = join(dir, 'keyring');
const maintenance = join(dir, 'maintenance');
writeFileSync(oldFile, oldKey.toString('base64'));
writeFileSync(newFile, newKey.toString('base64'));
writeFileSync(maintenance, 'on\n');

await assert.rejects(
  () => rekeyDatabase({
    databaseUrl: url,
    oldKeyFile: oldFile,
    newKeyFile: newFile,
    keyringFile: keyring,
    sealDir: join(dir, 'seal-fault'),
    maintenanceFile: maintenance,
    writersStopped: true,
    fault: 'before-commit',
  }),
  /fault before commit/,
);
const still = new pg.Client({ connectionString: url });
await still.connect();
const before = await still.query('SELECT encrypted_payload, iv FROM item_credential');
assert.equal(decrypt(before.rows[0].encrypted_payload, before.rows[0].iv, aad, oldKey), plain);
await still.end();

const crash = new pg.Client({ connectionString: url });
await crash.connect();
await crash.query('BEGIN');
await crash.query('UPDATE item_credential SET encrypted_payload = $1', ['dead']);
crash.on('error', () => undefined);
crash.connection.stream.destroy();
await new Promise((resolve) => setTimeout(resolve, 300));
const afterCrash = new pg.Client({ connectionString: url });
await afterCrash.connect();
const crashed = await afterCrash.query('SELECT encrypted_payload, iv FROM item_credential');
await afterCrash.end();
assert.equal(decrypt(crashed.rows[0].encrypted_payload, crashed.rows[0].iv, aad, oldKey), plain);

const afterRing = await rekeyDatabase({
  databaseUrl: url,
  oldKeyFile: oldFile,
  newKeyFile: newFile,
  keyringFile: join(dir, 'ring-only'),
  sealDir: join(dir, 'seal-ring'),
  maintenanceFile: maintenance,
  writersStopped: true,
  fault: 'after-keyring',
});
assert.equal(afterRing.committed, false);
const ring = readFileSync(join(dir, 'ring-only'), 'utf8').trim().split('\n');
assert.equal(ring.length, 2);

await rekeyDatabase({
  databaseUrl: url,
  oldKeyFile: oldFile,
  newKeyFile: newFile,
  keyringFile: join(dir, 'ring-done'),
  sealDir: join(dir, 'seal-done'),
  maintenanceFile: maintenance,
  writersStopped: true,
});
const done = new pg.Client({ connectionString: url });
await done.connect();
const row = await done.query('SELECT encrypted_payload, iv FROM item_credential');
await done.end();
assert.equal(row.rows[0].encrypted_payload.startsWith('v2:'), true);
assert.equal(decrypt(row.rows[0].encrypted_payload, row.rows[0].iv, aad, newKey), plain);
assert.throws(() => decrypt(row.rows[0].encrypted_payload, row.rows[0].iv, aad, oldKey));
const keys = readFileSync(join(dir, 'ring-done'), 'utf8').trim().split('\n').map((line) => Buffer.from(line, 'base64'));
assert.equal(decryptAny(row.rows[0].encrypted_payload, row.rows[0].iv, aad, keys), plain);
console.log('offline rekey ok');
