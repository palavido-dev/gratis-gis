// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-portal restore runs `pg_restore --clean --if-exists` over the
// live database. On this schema that always exits 1: the partitions of
// `observation` inherit the parent's primary key, and pg_restore's
// per-partition DROP CONSTRAINT fails with "cannot drop inherited
// constraint". The restore used to reject on any non-zero exit, so no
// in-portal restore could succeed. This dumps the migrated schema with
// pg_dump -Fc and restores it over itself through the service's real
// pg_restore call. Needs pg_dump and pg_restore on PATH.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import type { TileCacheService } from '../engine/tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import type { BackupService } from './backup.service.js';
import { BackupRestoreService } from './backup-restore.service.js';
import type { MaintenanceModeService } from './maintenance-mode.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the pg_restore round trip suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_backup_restore_roundtrip';
const KEEP = '40000000-0000-4000-8000-000000000001';
const LATER = '40000000-0000-4000-8000-000000000002';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('pg_restore round trip of the migrated schema', () => {
  // Built lazily: describe.skip still runs this body without a URL.
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let dir = '';
  let dumpPath = '';
  let pool: Pool;
  let restore: (dump: string) => Promise<void>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gg-restore-'));
    dumpPath = join(dir, 'gratisgis.dump');
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 2 });
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'kept', 'Kept')`,
      [KEEP],
    );
    const dump = spawnSync('pg_dump', ['-Fc', '-f', dumpPath, url], { encoding: 'utf8' });
    if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);

    const cfg = {
      get: (key: string, fallback?: string) => (key === 'DATABASE_URL' ? url : fallback),
    } as unknown as ConfigService;
    const svc = new BackupRestoreService(
      {} as PrismaService,
      cfg,
      {} as BackupService,
      {} as MaintenanceModeService,
      {} as TileCacheService,
    );
    restore = (p) =>
      (svc as unknown as { runPgRestore: (p: string) => Promise<void> }).runPgRestore(p);
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) rmSync(dir, { recursive: true, force: true });
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  });

  it('pg_restore on its own exits 1 with only the inherited constraint errors', () => {
    const run = spawnSync(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-d', url, dumpPath],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/cannot drop inherited constraint "observation_p\d{6}_pkey"/);
  });

  it('the service restores over the live schema and reports success', async () => {
    // Change the data after the dump; the restore must undo it.
    await pool.query(`DELETE FROM organization WHERE id = $1`, [KEEP]);
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'later', 'Later')`,
      [LATER],
    );
    await expect(restore(dumpPath)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM organization WHERE id IN ($1, $2)`,
      [KEEP, LATER],
    );
    expect(rows.map((r) => r.id)).toEqual([KEEP]);
    // The partitioned table and its key came back whole.
    const pk = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'observation_pkey'`,
    );
    expect(pk.rowCount).toBe(1);
  });

  it('still fails on any other error', async () => {
    await expect(restore(join(dir, 'missing.dump'))).rejects.toThrow(/pg_restore failed/);
  });
});
