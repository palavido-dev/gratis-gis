// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two real Postgres sessions reserve the same cap. One commit is
 * abandoned without COMMIT so a crashed transaction leaves no row.
 * A reservation older than 70 minutes is removed by the next reserve.
 *
 * Usage: DATABASE_URL=... node scripts/quota-race.mjs
 * The URL is not printed.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const { Client } = pg;

async function reserve(client, orgId, bytes, purpose) {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('gratis-storage-reserve', 0))",
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [orgId],
    );
    await client.query(
      `DELETE FROM storage_reservation AS r
       WHERE r.org_id = $1::uuid
         AND r.created_at < now() - interval '70 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM import_job AS live
           WHERE live.org_id = r.org_id
             AND live.status IN ('queued', 'running')
             AND (live.id::text = r.purpose OR live.staging_id = r.purpose)
         )`,
      [orgId],
    );
    const used = await client.query(
      'SELECT COALESCE(SUM(bytes), 0)::text AS used FROM storage_reservation WHERE org_id = $1',
      [orgId],
    );
    const sum = BigInt(used.rows[0].used);
    if (sum + bytes > 100n) {
      await client.query('ROLLBACK');
      return 'refused';
    }
    await client.query(
      'INSERT INTO storage_reservation (id, org_id, bytes, purpose) VALUES (gen_random_uuid(), $1, $2, $3)',
      [orgId, bytes.toString(), purpose],
    );
    await client.query('COMMIT');
    return 'ok';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

const setup = new Client({ connectionString: url });
await setup.connect();
await setup.query('BEGIN');
await setup.query(
  "INSERT INTO organization (id, slug, name) VALUES ('11111111-1111-4111-8111-111111111111', 'quota-race', 'Quota race') ON CONFLICT (id) DO NOTHING",
);
await setup.query(
  "INSERT INTO org_resource_quota (org_id, max_storage_bytes) VALUES ('11111111-1111-4111-8111-111111111111', 100) ON CONFLICT (org_id) DO UPDATE SET max_storage_bytes = 100",
);
await setup.query(
  "DELETE FROM storage_reservation WHERE org_id = '11111111-1111-4111-8111-111111111111'",
);
await setup.query('COMMIT');
await setup.end();

const orgId = '11111111-1111-4111-8111-111111111111';
const a = new Client({ connectionString: url });
const b = new Client({ connectionString: url });
await a.connect();
await b.connect();
const results = await Promise.all([
  reserve(a, orgId, 80n, 'a'),
  reserve(b, orgId, 80n, 'b'),
]);
await a.end();
await b.end();
results.sort();
if (results.join(',') !== 'ok,refused') {
  console.error('concurrent reserve results', results.join(','));
  process.exit(1);
}

const crash = new Client({ connectionString: url });
await crash.connect();
await crash.query('BEGIN');
await crash.query(
  "INSERT INTO storage_reservation (id, org_id, bytes, purpose) VALUES (gen_random_uuid(), $1, 10, 'crash')",
  [orgId],
);
crash.on('error', () => undefined);
crash.connection.stream.destroy();
await new Promise((resolve) => setTimeout(resolve, 300));

const check = new Client({ connectionString: url });
await check.connect();
const afterCrash = await check.query(
  "SELECT count(*)::int AS n FROM storage_reservation WHERE purpose = 'crash'",
);
if (afterCrash.rows[0].n !== 0) {
  console.error('crashed transaction left a reservation');
  process.exit(1);
}

await check.query(
  "INSERT INTO storage_reservation (id, org_id, bytes, purpose, created_at) VALUES (gen_random_uuid(), $1, 50, 'stale', now() - interval '71 minutes')",
  [orgId],
);
const sweeper = new Client({ connectionString: url });
await sweeper.connect();
await reserve(sweeper, orgId, 10n, 'after-stale');
await sweeper.end();
const stale = await check.query(
  "SELECT count(*)::int AS n FROM storage_reservation WHERE purpose = 'stale'",
);
if (stale.rows[0].n !== 0) {
  console.error('stale reservation was not removed');
  process.exit(1);
}
const released = await check.query(
  "DELETE FROM storage_reservation WHERE purpose = 'after-stale'",
);
const releasedAgain = await check.query(
  "DELETE FROM storage_reservation WHERE purpose = 'after-stale'",
);
if (released.rowCount !== 1 || releasedAgain.rowCount !== 0) {
  console.error('release was not exactly once');
  process.exit(1);
}
await check.query(
  "DELETE FROM storage_reservation WHERE org_id = $1",
  [orgId],
);
await check.query("DELETE FROM org_resource_quota WHERE org_id = $1", [orgId]);
await check.query("DELETE FROM organization WHERE id = $1", [orgId]);
await check.end();
console.log('quota race ok');
