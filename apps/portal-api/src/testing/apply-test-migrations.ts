// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Apply the repo's Prisma migrations to a database that does not have
// pg_partman. The partition migration's create_parent call is replaced
// with the monthly partitions that call would create. This is a
// limitation of the stock PostGIS image, not proof that
// partman.create_parent ran. The CI job that migrates the project
// Postgres image is that proof.

import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { withFileLock } from './file-lock.js';

/**
 * Some migrations change cluster-wide state (ALTER ROLE sets the app
 * role's statement_timeout). Each pg spec migrates its own database,
 * but parallel Jest workers on one server then update the same role
 * row and one fails with "tuple concurrently updated". Migrations run
 * one suite at a time under this lock.
 */
// Under the package's own node_modules cache rather than the shared
// system temp dir, so no other user can create or swap the lock.
const LOCK_DIR = join(process.cwd(), 'node_modules', '.cache', 'gratis-gis');
const MIGRATION_LOCK = join(LOCK_DIR, 'test-migrations.lock');

export function rewritePartitionMigration(sql: string): string {
  const cut = sql.indexOf('SELECT partman.create_parent');
  const resume = sql.indexOf('-- 6. Move existing data');
  if (cut < 0 || resume < 0) {
    throw new Error('partition migration no longer has the partman markers');
  }
  const head = sql
    .slice(0, cut)
    .replace(/CREATE SCHEMA IF NOT EXISTS partman;\s*/g, '')
    .replace(/CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;\s*/g, '');
  const partitions = `
DO $$
DECLARE
  m date := DATE '2025-01-01';
  horizon date := (date_trunc('month', now()) + interval '6 months')::date;
BEGIN
  WHILE m < horizon LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF observation FOR VALUES FROM (%L) TO (%L)',
      'observation_p' || to_char(m, 'YYYYMM'),
      m::timestamptz,
      (m + interval '1 month')::date::timestamptz
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
`;
  return head + partitions + sql.slice(resume);
}

export function applyTestMigrations(url: string, migrationsDir: string): void {
  mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  withFileLock(MIGRATION_LOCK, () => applyAll(url, migrationsDir));
}

function applyAll(url: string, migrationsDir: string): void {
  const dirs = readdirSync(migrationsDir)
    .filter((name) => name !== 'migration_lock.toml')
    .sort();
  for (const dir of dirs) {
    const file = join(migrationsDir, dir, 'migration.sql');
    let sql = readFileSync(file, 'utf8');
    if (dir.startsWith('20260508081000')) sql = rewritePartitionMigration(sql);
    const result = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1'], {
      input: sql,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `migration ${dir} failed\n${result.stderr}\n${result.stdout}`,
      );
    }
  }
}
