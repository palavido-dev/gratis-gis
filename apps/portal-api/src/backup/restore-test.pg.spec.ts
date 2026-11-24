// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Test latest backup" against a real PostgreSQL: a real pg_dump in a
 * real archive is restored into a scratch database with the real
 * createdb, pg_restore, psql and dropdb, once from a good archive and
 * once from a cut-short one. Both must leave no scratch database.
 *
 * Needs the PostgreSQL client tools on PATH, at least as new as the
 * server (pg_dump refuses a newer server).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';
import { Client as PgClient } from 'pg';

import type { BackupService } from './backup.service.js';
import { RestoreTestService, SCRATCH_PREFIX } from './restore-test.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the backup test pg suite would silently skip.',
  );
}

jest.setTimeout(120_000);

function clientMajor(): number {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  const m = /(\d+)\./.exec(r.stdout ?? '');
  return m ? Number(m[1]) : 0;
}

d('Test latest backup against Postgres', () => {
  const srcDb = `gg_rt_src_${randomBytes(4).toString('hex')}`;
  let admin: PgClient;
  let srcUrl: string;
  let dir: string;
  let archive: string;
  let toolsOk = true;

  const scratchLeft = async () =>
    (
      await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE '${SCRATCH_PREFIX}%'`,
      )
    ).rows.map((r) => r.datname);

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    const server = Math.floor(
      Number(
        (
          await admin.query<{ v: string }>('SELECT current_setting($1) AS v', [
            'server_version_num',
          ])
        ).rows[0]!.v,
      ) / 10000,
    );
    if (clientMajor() < server) {
      toolsOk = false;
      // Not a pass: say plainly that the real tools did not run.
      console.warn(
        `pg_dump ${clientMajor()} cannot dump server ${server}; this suite needs newer client tools.`,
      );
      return;
    }
    await admin.query(`CREATE DATABASE ${srcDb}`);
    const u = new URL(TEST_URL!);
    u.pathname = `/${srcDb}`;
    srcUrl = u.toString();
    const src = new PgClient({ connectionString: srcUrl });
    await src.connect();
    await src.query(`
      CREATE TABLE organization (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE "user" (id uuid PRIMARY KEY, username text NOT NULL);
      CREATE TABLE item (id uuid PRIMARY KEY, title text NOT NULL);
      CREATE TABLE _prisma_migrations (
        id text PRIMARY KEY, migration_name text NOT NULL,
        finished_at timestamptz, rolled_back_at timestamptz);
      INSERT INTO organization VALUES ('00000000-0000-4000-8000-000000000001', 'Acme');
      INSERT INTO "user" VALUES ('00000000-0000-4000-8000-000000000002', 'admin');
      INSERT INTO item SELECT gen_random_uuid(), 'item ' || g FROM generate_series(1, 25) g;
      INSERT INTO _prisma_migrations VALUES ('m1', '20260101000000_init', now(), NULL);
    `);
    await src.end();

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-rtpg-'));
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'postgres'), { recursive: true });
    execFileSync('pg_dump', [
      '-Fc',
      '--no-owner',
      '--no-privileges',
      '-f',
      path.join(stage, 'postgres', 'gratisgis.dump'),
      srcUrl,
    ]);
    fs.writeFileSync(
      path.join(stage, 'manifest.json'),
      JSON.stringify({ version: 1, databases: ['gratisgis'] }),
    );
    archive = path.join(dir, 'backup.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', stage, 'manifest.json', 'postgres/gratisgis.dump']);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    await admin?.query(`DROP DATABASE IF EXISTS ${srcDb} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  });

  function service(updates: Array<Record<string, unknown>>) {
    const prisma = {
      backupRestoreTest: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        },
      },
    };
    const cfg = { get: (k: string, dflt?: string) => (k === 'DATABASE_URL' ? srcUrl : dflt) };
    return new RestoreTestService(prisma as never, cfg as never, {} as BackupService);
  }

  it('passes on a good archive and drops the scratch database', async () => {
    if (!toolsOk) return;
    const updates: Array<Record<string, unknown>> = [];
    const res = await service(updates).perform('t1', archive);
    expect(res).toEqual({ ok: true, error: null });
    expect(updates.at(-1)).toMatchObject({
      status: 'passed',
      summary: { organizations: 1, users: 1, items: 25, migrations: 1 },
    });
    expect(await scratchLeft()).toEqual([]);
  });

  it('fails on a truncated archive and drops the scratch database', async () => {
    if (!toolsOk) return;
    const cut = path.join(dir, 'cut.tar.gz');
    const full = fs.readFileSync(archive);
    fs.writeFileSync(cut, full.subarray(0, Math.floor(full.length * 0.6)));
    const updates: Array<Record<string, unknown>> = [];
    const res = await service(updates).perform('t2', cut);
    expect(res.ok).toBe(false);
    expect(updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(String(res.error)).not.toMatch(/postgres(ql)?:\/\//);
    expect(await scratchLeft()).toEqual([]);
  });
});
