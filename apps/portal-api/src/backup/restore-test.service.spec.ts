// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConflictException } from '@nestjs/common';

import type { BackupService } from './backup.service.js';
import {
  childEnv,
  databaseName,
  judgeSanity,
  parseDfAvailable,
  pgEnvFromUrl,
  RestoreTestService,
  spaceNeeded,
  type CommandRunner,
} from './restore-test.service.js';

const DB_URL = 'postgresql://gg:p%40ss@postgres:5432/gratisgis?schema=public&sslmode=disable';
const GB = 1024 ** 3;

describe('scratch restore helpers', () => {
  it('turns the URL into libpq variables, the password included, and no URL', () => {
    expect(pgEnvFromUrl(DB_URL)).toEqual({
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'gg',
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'disable',
    });
    expect(databaseName(DB_URL)).toBe('gratisgis');
    expect(() => databaseName('postgresql://h/a;b')).toThrow();
  });

  it('gives a child process only what it needs', () => {
    const saved = { ...process.env };
    process.env.DATABASE_URL = DB_URL;
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'k';
    try {
      const env = childEnv({ PGPASSWORD: 'x' });
      expect(env.PGPASSWORD).toBe('x');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    } finally {
      process.env = saved;
    }
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

  it('reads df and the room a test needs', () => {
    expect(
      parseDfAvailable(
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /var/lib/postgresql/data\n',
      ),
    ).toBe(60 * 1024);
    expect(parseDfAvailable('nonsense')).toBeNull();
    expect(spaceNeeded(4 * GB)).toBe(5 * GB + 256 * 1024 * 1024);
  });
});

describe('RestoreTestService', () => {
  let dir: string;
  let archive: string;
  let calls: Array<{
    bin: string;
    args: string[];
    stdinBytes: number | null;
    env: Record<string, string> | undefined;
  }>;
  let updates: Array<Record<string, unknown>>;
  let svc: RestoreTestService;
  let dbSize: number;
  let df: string | null;

  const baseRunner: CommandRunner = async (bin, args, opts) => {
    let stdinBytes: number | null = null;
    if (opts?.stdin) {
      stdinBytes = 0;
      for await (const c of opts.stdin as AsyncIterable<Buffer>) stdinBytes += c.length;
    }
    calls.push({ bin, args, stdinBytes, env: opts?.env });
    const joined = args.join(' ');
    if (joined.includes('pg_database_size')) return `${dbSize}\n`;
    if (joined.includes(' df ') || args.includes('df')) {
      if (df === null) throw new Error('df failed');
      return df;
    }
    if (joined.includes('count(*)')) return '3\n';
    return '';
  };

  function service(extra: Record<string, string> = {}) {
    const prisma = {
      backupRestoreTest: {
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'new',
          ...data,
        })),
      },
    };
    const vars: Record<string, string> = { DATABASE_URL: DB_URL, ...extra };
    const cfg = { get: (k: string, d?: string) => vars[k] ?? d };
    const backup = {
      liveRun: async () => null,
      listRunsWithArchiveState: async () => [
        { id: 'run-1', status: 'succeeded', filename: 'backup.tar.gz', archiveOnDisk: true },
      ],
      resolveArchivePath: async () => ({ filename: 'backup.tar.gz', path: archive }),
    } as unknown as BackupService;
    const s = new RestoreTestService(prisma as never, cfg as never, backup);
    s.runner = baseRunner;
    // The test itself is not under test here.
    jest.spyOn(s, 'perform').mockResolvedValue({ ok: true, error: null });
    return { s, prisma };
  }

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
    dbSize = 2 * GB;
    df = null;
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
    svc.runner = baseRunner;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a second test started at the same moment is refused by the database index', async () => {
    const { s, prisma } = service({ BACKUP_PGDUMP_DOCKER_CONTAINER: 'db' });
    df = 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 99999999 1% /d\n';
    prisma.backupRestoreTest.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(s.start('u1')).rejects.toThrow(/already running/);
    expect(s.perform).not.toHaveBeenCalled();
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

  it('never puts the database URL or password in a command line, and hands children a minimal env', async () => {
    const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'must-not-reach-a-child';
    try {
      await svc.perform('t1', archive);
    } finally {
      if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    }
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) {
      const argv = c.args.join(' ');
      expect(argv).not.toContain('postgresql://');
      expect(argv).not.toContain('p@ss');
      expect(c.env?.PGPASSWORD).toBe('p@ss');
      expect(c.env?.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
      expect(c.env?.DATABASE_URL).toBeUndefined();
    }
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

  it('fails when the restored copy has no organization', async () => {
    svc.runner = async (bin, args, opts) => {
      if (bin === 'psql' && args.join(' ').includes('FROM organization')) return '0\n';
      return baseRunner(bin, args, opts);
    };
    const res = await svc.perform('t4', archive);
    expect(res.error).toMatch(/no organization/);
  });

  it('runs inside the database container in docker mode, passing variables by name only', async () => {
    const cfg = {
      get: (k: string, d?: string) =>
        k === 'DATABASE_URL' ? DB_URL : k === 'BACKUP_PGDUMP_DOCKER_CONTAINER' ? 'gg-postgres' : d,
    };
    const prisma = { backupRestoreTest: { update: jest.fn() } };
    const docker = new RestoreTestService(prisma as never, cfg as never, {} as BackupService);
    docker.runner = baseRunner;
    await docker.perform('t5', archive);
    expect(calls.every((c) => c.bin === 'docker')).toBe(true);
    const restore = calls.find((c) => c.args.includes('pg_restore'))!;
    expect(restore.args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(restore.args).toContain('PGPASSWORD');
    expect(restore.args.join(' ')).not.toContain('p@ss');
    expect(restore.env?.PGPASSWORD).toBe('p@ss');
  });

  describe('free space', () => {
    it('refuses a test that would not fit in the measured free space', async () => {
      df = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1 1 ${Math.floor(GB / 1024)} 99% /d\n`;
      const { s, prisma } = service({ BACKUP_PGDUMP_DOCKER_CONTAINER: 'gg-postgres' });
      await expect(s.start('u1')).rejects.toThrow(/Not enough free space/);
      expect(prisma.backupRestoreTest.create).not.toHaveBeenCalled();
    });

    it('starts when the measured free space is enough', async () => {
      df = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1 1 ${Math.floor((10 * GB) / 1024)} 9% /d\n`;
      const { s, prisma } = service({ BACKUP_PGDUMP_DOCKER_CONTAINER: 'gg-postgres' });
      await expect(s.start('u1')).resolves.toMatchObject({ id: 'new' });
      expect(prisma.backupRestoreTest.create).toHaveBeenCalled();
    });

    it('asks the admin to confirm the size when free space cannot be measured', async () => {
      const { s, prisma } = service();
      const err = await s.start('u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        needsConfirmation: true,
        databaseBytes: 2 * GB,
      });
      await expect(s.start('u1', GB)).rejects.toThrow(/cannot be measured/);
      expect(prisma.backupRestoreTest.create).not.toHaveBeenCalled();
      await expect(s.start('u1', 2 * GB)).resolves.toMatchObject({ id: 'new' });
    });

    it('measures a host data directory with statfs', async () => {
      const { s } = service({ BACKUP_PG_DATA_DIR: dir });
      const p = await s.preflight();
      expect(p.freeBytes).toBeGreaterThan(0);
      expect(p.neededBytes).toBe(spaceNeeded(2 * GB));
    });
  });
});
