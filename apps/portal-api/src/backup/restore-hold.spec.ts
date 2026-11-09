// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  BackupRestoreService,
  RestoreNotStartedError,
  parseMigrationsCopy,
  schemaMismatch,
} from './backup-restore.service.js';
import { BackupController } from './backup.controller.js';
import { BackupService } from './backup.service.js';
import {
  MaintenanceModeService,
  restoreMarkerPath,
} from './maintenance-mode.service.js';
import type { TileCacheService } from '../engine/tile-cache.service.js';

const MIGRATIONS = ['20260101000000_a', '20260201000000_b'];

/** In-memory stand-in for the system_setting row both replicas poll. */
function settingStore() {
  const store: { value: unknown } = { value: null };
  const prisma = {
    systemSetting: {
      findUnique: jest.fn(async () =>
        store.value === null ? null : { key: 'maintenance', value: store.value },
      ),
      upsert: jest.fn(async (args: { update: { value: unknown } }) => {
        store.value = args.update.value;
        return {};
      }),
    },
  };
  return { store, prisma };
}

function replica(prisma: unknown): MaintenanceModeService {
  return new MaintenanceModeService(prisma as PrismaService);
}

const refresh = (m: MaintenanceModeService) =>
  (m as unknown as { refresh(): Promise<void> }).refresh();

describe('restore keeps maintenance on (API-OPS-01)', () => {
  let dir: string;
  const prevDir = process.env.BACKUP_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-restore-hold-'));
    process.env.BACKUP_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = prevDir;
  });

  it('a poll that finds the row gone or inactive does not clear a restore hold', async () => {
    const { store, prisma } = settingStore();
    const a = replica(prisma);
    const b = replica(prisma);
    await a.activate('restore');
    await a.beginRestoreHold('restoring');
    await refresh(b);
    expect(b.isActive()).toBe(true);

    // pg_restore drops system_setting, then loads the archive's row.
    store.value = null;
    await refresh(a);
    await refresh(b);
    expect(a.isActive()).toBe(true);
    expect(b.isActive()).toBe(true);
    store.value = { active: false, reason: null, startedAt: null };
    await refresh(a);
    await refresh(b);
    expect(a.isActive()).toBe(true);
    expect(b.isActive()).toBe(true);

    await a.reassertHold();
    expect(store.value).toMatchObject({ active: true });
    await a.endRestoreHold(true);
    expect(existsSync(restoreMarkerPath())).toBe(false);
  });

  it('a process that dies mid-restore leaves the portal in maintenance', async () => {
    const { store, prisma } = settingStore();
    const a = replica(prisma);
    await a.beginRestoreHold('restoring');
    // Crash: the local hold is gone with the process, and the dump's
    // own inactive row is in the table.
    store.value = { active: false, reason: null, startedAt: null };
    const restarted = replica(prisma);
    await refresh(restarted);
    expect(restarted.isActive()).toBe(true);
    expect(restarted.snapshot().reason).toMatch(/restore did not finish/);
  });

  it('a failed restore keeps the marker', async () => {
    const { prisma } = settingStore();
    const a = replica(prisma);
    await a.beginRestoreHold('restoring');
    await a.endRestoreHold(false);
    expect(a.isHeldLocally()).toBe(false);
    expect(existsSync(restoreMarkerPath())).toBe(true);
    expect(replica(prisma).isActive()).toBe(true);
  });
});

describe('runRestore', () => {
  let dir: string;
  const prevDir = process.env.BACKUP_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-restore-run-'));
    process.env.BACKUP_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = prevDir;
  });

  function archive(manifest: Record<string, unknown>): string {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'postgres'), { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(src, 'postgres', 'gratisgis.dump'), 'dump');
    const file = join(dir, 'backup-x.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', src, 'manifest.json', 'postgres']);
    return file;
  }

  function setup(opts: {
    manifest?: Record<string, unknown>;
    live?: { id: string; startedAt: Date } | null;
    liveMigrations?: string[];
  } = {}) {
    const { store, prisma: settings } = settingStore();
    const liveRuns = [
      { id: 'run-src', status: 'succeeded', filename: 'backup-x.tar.gz' },
      { id: 'run-newer', status: 'succeeded', filename: 'backup-y.tar.gz' },
    ];
    const notices = [{ runId: 'run-old' }];
    const tx = jest.fn(async (ops: unknown[]) => ops);
    const prisma = {
      ...settings,
      backupRun: {
        findMany: jest.fn(async () => liveRuns),
        deleteMany: jest.fn(() => 'deleteRuns'),
        createMany: jest.fn((a: unknown) => ({ createRuns: a })),
      },
      backupFailureNotice: {
        findMany: jest.fn(async () => notices),
        deleteMany: jest.fn(() => 'deleteNotices'),
        createMany: jest.fn((a: unknown) => ({ createNotices: a })),
      },
      backupRestore: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(() => 'deleteRestores'),
        createMany: jest.fn((a: unknown) => ({ createRestores: a })),
        create: jest.fn(async () => ({ id: 'audit-1' })),
      },
      $transaction: tx,
    };
    const file = archive(
      opts.manifest ?? {
        version: 1,
        databases: ['gratisgis'],
        appliedMigrations: MIGRATIONS,
      },
    );
    const backup = {
      resolveArchivePath: jest.fn(async () => ({
        path: file,
        filename: 'backup-x.tar.gz',
      })),
      liveRun: jest.fn(async () => opts.live ?? null),
      appliedMigrations: jest.fn(async () => opts.liveMigrations ?? MIGRATIONS),
    };
    const mode = replica(prisma);
    const other = replica(prisma);
    const svc = new BackupRestoreService(
      prisma as unknown as PrismaService,
      new ConfigService(),
      backup as unknown as BackupService,
      mode,
      { resetAfterRestore: async () => {} } as unknown as TileCacheService,
    );
    const pgRestore = jest.fn(async () => {});
    const minio = jest.fn(async () => {});
    Object.assign(svc as unknown as Record<string, unknown>, {
      runPgRestore: pgRestore,
      restoreMinio: minio,
    });
    return { svc, mode, other, store, prisma, pgRestore, minio, tx };
  }

  it('writes the marker before pg_restore and re-asserts the row after it', async () => {
    const t = setup();
    await t.mode.activate('restore');
    t.pgRestore.mockImplementation(async () => {
      // The hold and marker are in place before pg_restore runs.
      expect(existsSync(restoreMarkerPath())).toBe(true);
      // pg_restore swaps in the archive's inactive row.
      t.store.value = { active: false, reason: null, startedAt: null };
      await refresh(t.mode);
      await refresh(t.other);
      expect(t.mode.isActive()).toBe(true);
      expect(t.other.isActive()).toBe(true);
    });
    t.minio.mockImplementation(async () => {
      // The object-store phase runs with the row active again.
      expect(t.store.value).toMatchObject({ active: true });
      await refresh(t.other);
      expect(t.other.isActive()).toBe(true);
    });
    await expect(
      t.svc.runRestore({ runId: 'run-src', startedBy: 'u1' }),
    ).resolves.toEqual({ id: 'audit-1' });
    expect(t.pgRestore).toHaveBeenCalledTimes(1);
    expect(t.minio).toHaveBeenCalledTimes(1);
    expect(existsSync(restoreMarkerPath())).toBe(false);
    expect(t.mode.isHeldLocally()).toBe(false);
  });

  it('puts the live backup history back after pg_restore (API-OPS-03)', async () => {
    const t = setup();
    await t.mode.activate('restore');
    await t.svc.runRestore({ runId: 'run-src', startedBy: 'u1' });
    expect(t.tx).toHaveBeenCalledTimes(1);
    expect(t.prisma.backupRun.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ id: 'run-src', status: 'succeeded' }),
        expect.objectContaining({ id: 'run-newer' }),
      ],
    });
    expect(t.prisma.backupFailureNotice.createMany).toHaveBeenCalledWith({
      data: [{ runId: 'run-old' }],
    });
    // Snapshot is taken before pg_restore replaces the tables.
    const snapOrder = t.prisma.backupRun.findMany.mock.invocationCallOrder[0]!;
    const restoreOrder = t.pgRestore.mock.invocationCallOrder[0]!;
    expect(snapOrder).toBeLessThan(restoreOrder);
  });

  it('a pg_restore failure keeps the marker so the portal stays in maintenance', async () => {
    const t = setup();
    await t.mode.activate('restore');
    t.pgRestore.mockRejectedValue(new Error('pg_restore exited with code 1'));
    const err = await t.svc
      .runRestore({ runId: 'run-src', startedBy: 'u1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RestoreNotStartedError);
    expect(existsSync(restoreMarkerPath())).toBe(true);
    t.store.value = { active: false, reason: null, startedAt: null };
    const restarted = replica(t.prisma);
    await refresh(restarted);
    expect(restarted.isActive()).toBe(true);
  });

  it('refuses an archive with a different schema before touching anything (API-OPS-05)', async () => {
    const t = setup({ liveMigrations: [...MIGRATIONS, '20261108140000_admin_audit_event'] });
    await t.mode.activate('restore');
    const err = await t.svc
      .runRestore({ runId: 'run-src', startedBy: 'u1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreNotStartedError);
    expect((err as Error).message).toMatch(/20261108140000_admin_audit_event/);
    expect(t.pgRestore).not.toHaveBeenCalled();
    expect(existsSync(restoreMarkerPath())).toBe(false);
  });

  it('re-checks for a backup right before the hold', async () => {
    // Another replica starts a scheduled backup in the poll interval
    // before it sees the maintenance flag: the first check is clean,
    // the run exists by the time the hold would be written.
    const t = setup();
    (t.svc as unknown as { backup: { liveRun: jest.Mock } }).backup.liveRun
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b2', startedAt: new Date() });
    await t.mode.activate('restore');
    await expect(
      t.svc.runRestore({ runId: 'run-src', startedBy: 'u1' }),
    ).rejects.toBeInstanceOf(RestoreNotStartedError);
    expect(existsSync(restoreMarkerPath())).toBe(false);
    expect(t.mode.isHeldLocally()).toBe(false);
    expect(t.pgRestore).not.toHaveBeenCalled();
  });

  it('refuses while a backup is running (API-OPS-04)', async () => {
    const t = setup({ live: { id: 'b1', startedAt: new Date() } });
    await t.mode.activate('restore');
    await expect(
      t.svc.runRestore({ runId: 'run-src', startedBy: 'u1' }),
    ).rejects.toBeInstanceOf(RestoreNotStartedError);
    await expect(t.svc.preflight('run-src')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(t.pgRestore).not.toHaveBeenCalled();
  });
});

describe('schema compatibility helpers (API-OPS-05)', () => {
  it('matches equal migration sets only', () => {
    expect(schemaMismatch(['a', 'b'], ['b', 'a'], null)).toBeNull();
    expect(schemaMismatch(['a'], ['a', 'b'], '0.9.0')).toMatch(
      /GratisGIS 0\.9\.0.*made before 1 database migration.*starting with b/s,
    );
    expect(schemaMismatch(['a', 'c'], ['a'], null)).toMatch(/Upgrade the portal/);
    expect(schemaMismatch(['a', 'c'], ['a', 'b'], null)).toMatch(/different database schema/);
  });

  it('reads finished, not rolled back, migrations from pg_restore output', () => {
    const out = [
      'SET statement_timeout = 0;',
      'COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;',
      'a\tx\t2026-11-09 00:15:42+00\t20260101_b\t\\N\t\\N\t2026-11-09 00:15:42+00\t1',
      'b\tx\t2026-11-09 00:15:42+00\t20250101_a\tline1\\nline2\t\\N\t2026-11-09 00:15:42+00\t1',
      'c\tx\t\\N\t20270101_unfinished\t\\N\t\\N\t2026-11-09 00:15:42+00\t0',
      'd\tx\t2026-11-09 00:15:42+00\t20270102_rolled\t\\N\t2026-11-09 00:15:42+00\t2026-11-09 00:15:42+00\t0',
      '\\.',
      '',
    ].join('\n');
    expect(parseMigrationsCopy(out)).toEqual(['20250101_a', '20260101_b']);
    expect(parseMigrationsCopy('SET x = 1;\n')).toBeNull();
  });
});

describe('backups and leader crons pause during maintenance (API-OPS-04)', () => {
  it('runBackup refuses while maintenance is active', async () => {
    const prisma = {
      backupRun: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    const mode = { isActive: () => true } as unknown as MaintenanceModeService;
    const svc = new BackupService(
      prisma as unknown as PrismaService,
      new ConfigService(),
      undefined,
      mode,
    );
    await expect(svc.runBackup('scheduled', null)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.backupRun.create).not.toHaveBeenCalled();
  });

  it('shouldRun is false on the leader while a pause probe is on', () => {
    const leader = new LeaderElectionService();
    (leader as unknown as { isLeader: boolean }).isLeader = true;
    let maintenance = false;
    leader.pauseWhile(() => maintenance);
    expect(leader.shouldRun()).toBe(true);
    maintenance = true;
    expect(leader.shouldRun()).toBe(false);
    // Boot-time registration still sees the lock.
    expect(leader.holdsLock()).toBe(true);
  });
});

describe('restore route leaves no false hold when nothing changed', () => {
  function controller(restore: Partial<BackupRestoreService>) {
    const mode = {
      snapshot: jest.fn(() => ({ active: false, reason: null, startedAt: null })),
      activate: jest.fn(async () => {}),
      deactivate: jest.fn(async () => {}),
    };
    const prisma = {
      organization: { findFirst: jest.fn(async () => ({ name: 'Acme' })) },
    };
    const ctl = new BackupController(
      {} as never,
      restore as BackupRestoreService,
      mode as unknown as MaintenanceModeService,
      prisma as unknown as PrismaService,
      {} as never,
    );
    return { ctl, mode };
  }
  const user = { id: 'u1', orgId: 'o1', username: 'admin' } as never;

  it('a preflight refusal never raises maintenance', async () => {
    const { ctl, mode } = controller({
      preflight: jest.fn(async () => {
        throw new ConflictException('A backup is running');
      }),
      runRestore: jest.fn(),
    });
    await expect(
      ctl.runRestore(user, 'run-1', { confirmName: 'acme' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mode.activate).not.toHaveBeenCalled();
  });

  it('a restore that stopped before pg_restore lifts maintenance', async () => {
    const { ctl, mode } = controller({
      preflight: jest.fn(async () => {}),
      runRestore: jest.fn(async () => {
        throw new RestoreNotStartedError('schema differs');
      }),
    });
    await expect(
      ctl.runRestore(user, 'run-1', { confirmName: 'acme' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mode.activate).toHaveBeenCalledTimes(1);
    expect(mode.deactivate).toHaveBeenCalledTimes(1);
  });
});
