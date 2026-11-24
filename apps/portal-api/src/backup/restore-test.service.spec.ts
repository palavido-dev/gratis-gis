// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BackupService } from './backup.service.js';
import { adminUrl, judgeSanity, RestoreTestService, scratchUrl } from './restore-test.service.js';

const DB_URL = 'postgresql://gg:pw@postgres:5432/gratisgis?schema=public&sslmode=disable';

describe('scratch restore helpers', () => {
  it('points the URL at the scratch database and drops Prisma parameters', () => {
    expect(scratchUrl(DB_URL, 'gg_restore_test_0123456789abcdef')).toBe(
      'postgresql://gg:pw@postgres:5432/gg_restore_test_0123456789abcdef?sslmode=disable',
    );
    expect(adminUrl(DB_URL)).toBe('postgresql://gg:pw@postgres:5432/postgres?sslmode=disable');
  });

  it('refuses any other database name', () => {
    expect(() => scratchUrl(DB_URL, 'gratisgis')).toThrow();
    expect(() => scratchUrl(DB_URL, 'gg_restore_test_x; DROP')).toThrow();
  });

  it('judges the counts', () => {
    expect(judgeSanity({ organizations: 1, users: 2, items: 0, migrations: 300 })).toBeNull();
    expect(judgeSanity({ organizations: 0, users: 0, items: 0, migrations: 300 })).toMatch(
      /organization/,
    );
    expect(judgeSanity({ organizations: 1, users: 0, items: 0, migrations: 0 })).toMatch(
      /migration/,
    );
  });
});

describe('RestoreTestService.perform', () => {
  let dir: string;
  let archive: string;
  let calls: Array<{ bin: string; args: string[]; stdinBytes: number | null }>;
  let updates: Array<Record<string, unknown>>;
  let svc: RestoreTestService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-rtest-'));
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(src, 'postgres'), { recursive: true });
    fs.writeFileSync(
      path.join(src, 'manifest.json'),
      JSON.stringify({ version: 1, databases: ['gratisgis'] }),
    );
    // Incompressible, so cutting the gzip file really cuts the dump.
    fs.writeFileSync(path.join(src, 'postgres', 'gratisgis.dump'), randomBytes(200_000));
    archive = path.join(dir, 'backup.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'manifest.json', 'postgres/gratisgis.dump']);

    calls = [];
    updates = [];
    const prisma = {
      backupRestoreTest: {
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        }),
      },
    };
    const cfg = { get: (k: string, d?: string) => (k === 'DATABASE_URL' ? DB_URL : d) };
    svc = new RestoreTestService(prisma as never, cfg as never, {} as BackupService);
    svc.runner = async (bin, args, stdin) => {
      let stdinBytes: number | null = null;
      if (stdin) {
        stdinBytes = 0;
        for await (const c of stdin as AsyncIterable<Buffer>) stdinBytes += c.length;
      }
      calls.push({ bin, args, stdinBytes });
      if (bin === 'psql' && args.join(' ').includes('count(*)')) return '3\n';
      return '';
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes on a good archive, feeding the whole dump to pg_restore, and drops the scratch database', async () => {
    const res = await svc.perform('t1', archive);
    expect(res).toEqual({ ok: true, error: null });
    const restore = calls.find((c) => c.bin === 'pg_restore')!;
    expect(restore.stdinBytes).toBe(200_000);
    const created = calls.find((c) => c.bin === 'createdb')!.args.at(-1)!;
    expect(created).toMatch(/^gg_restore_test_[0-9a-f]{16}$/);
    const dropped = calls.filter((c) => c.bin === 'dropdb').map((c) => c.args.at(-1));
    expect(dropped).toContain(created);
    expect(updates.at(-1)).toMatchObject({
      status: 'passed',
      summary: { organizations: 3, migrations: 3 },
    });
  });

  it('fails on a truncated archive and still drops the scratch database', async () => {
    const full = fs.readFileSync(archive);
    fs.writeFileSync(archive, full.subarray(0, Math.floor(full.length / 2)));
    const res = await svc.perform('t2', archive);
    expect(res.ok).toBe(false);
    expect(updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(String(updates.at(-1)!.error)).toMatch(/tar|archive|manifest/i);
    const created = calls.find((c) => c.bin === 'createdb')?.args.at(-1);
    if (created) {
      expect(calls.filter((c) => c.bin === 'dropdb').map((c) => c.args.at(-1))).toContain(created);
    }
  });

  it('fails when pg_restore fails, without the database URL in the message', async () => {
    const base = svc.runner;
    svc.runner = async (bin, args, stdin) => {
      if (bin === 'pg_restore') {
        for await (const _ of stdin as AsyncIterable<Buffer>) void _;
        throw new Error(`pg_restore failed (exit 1): could not connect to ${args.at(-1)}`);
      }
      return base(bin, args, stdin);
    };
    const res = await svc.perform('t3', archive);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain('pw@');
    expect(calls.some((c) => c.bin === 'dropdb')).toBe(true);
  });

  it('fails when the restored copy has no organization', async () => {
    const base = svc.runner;
    svc.runner = async (bin, args, stdin) => {
      if (bin === 'psql' && args.join(' ').includes('FROM organization')) return '0\n';
      return base(bin, args, stdin);
    };
    const res = await svc.perform('t4', archive);
    expect(res.error).toMatch(/no organization/);
  });

  it('runs inside the database container in docker mode', async () => {
    const cfg = {
      get: (k: string, d?: string) =>
        k === 'DATABASE_URL' ? DB_URL : k === 'BACKUP_PGDUMP_DOCKER_CONTAINER' ? 'gg-postgres' : d,
    };
    const prisma = { backupRestoreTest: { update: jest.fn() } };
    const docker = new RestoreTestService(prisma as never, cfg as never, {} as BackupService);
    docker.runner = svc.runner;
    await docker.perform('t5', archive);
    expect(calls.every((c) => c.bin === 'docker')).toBe(true);
    expect(calls.find((c) => c.args.includes('pg_restore'))!.args.slice(0, 3)).toEqual([
      'exec',
      '-i',
      'gg-postgres',
    ]);
  });
});
