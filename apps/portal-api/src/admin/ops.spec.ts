// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  failedRestore,
  MaintenanceAdminController,
} from './maintenance-admin.controller.js';
import { ResourceQuotaService } from './resource-quota.service.js';

import { diskDecision } from './resource-quota.js';
import {
  IngestStagingService,
  isStagingId,
  stagingDiskPath,
} from '../ingest/ingest-staging.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactJobError } from './jobs-monitor.service.js';
import { JobsMonitorService } from './jobs-monitor.service.js';
import { BackupFailureNotice } from '../backup/backup-failure-notice.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { AdminAuditService } from './admin-audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { MaintenanceModeService } from '../backup/maintenance-mode.service.js';

const user: AuthUser = {
  id: 'user-1',
  orgId: 'org-1',
  orgSlug: 'acme',
  username: 'ada',
  email: 'ada@example.com',
  orgRole: 'admin',
  groupIds: [],
  capabilities: new Set(),
};

describe('diskDecision', () => {
  it('counts bytes already held by other reservations', () => {
    expect(
      diskDecision({ requestedBytes: 30n, freeBytes: 100n, heldBytes: 80n }),
    ).toEqual({ ok: false, reason: 'disk' });
    expect(
      diskDecision({ requestedBytes: 20n, freeBytes: 100n, heldBytes: 80n }),
    ).toEqual({ ok: true });
  });

  it('refuses only a request larger than the free disk', () => {
    expect(diskDecision({ requestedBytes: 10n, freeBytes: 100n })).toEqual({ ok: true });
    expect(diskDecision({ requestedBytes: 50n, freeBytes: 40n })).toEqual({
      ok: false,
      reason: 'disk',
    });
    expect(diskDecision({ requestedBytes: 50n, freeBytes: null })).toEqual({ ok: true });
  });
});

describe('isStagingId', () => {
  it('accepts one UUID string and nothing else', () => {
    expect(isStagingId('3f2b8c4e-1d2a-4b5c-9e8f-0a1b2c3d4e5f')).toBe(true);
    expect(isStagingId(['3f2b8c4e-1d2a-4b5c-9e8f-0a1b2c3d4e5f'])).toBe(false);
    expect(isStagingId('../../etc')).toBe(false);
    expect(isStagingId({ length: 36 })).toBe(false);
    expect(isStagingId(undefined)).toBe(false);
  });
});

describe('job monitor', () => {
  it('redacts connection strings and does not offer retry for a running import', () => {
    expect(redactJobError('boom postgresql://ada:secret@db/app')).toBe('boom [redacted]');
    const jobs = new JobsMonitorService(
      {
        importJob: {
          findMany: async () => [
            {
              id: 'job-1',
              sourceFileName: 'parcels.geojson',
              mode: 'replace',
              status: 'running',
              errorMessage: null,
            },
          ],
        },
        analysisJob: { findMany: async () => [] },
        backupRun: { findMany: async () => [] },
      } as unknown as PrismaService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    return jobs.list('org-1').then((page) => {
      expect(page.jobs[0]?.actions).toEqual({ cancel: true, retry: false });
    });
  });

  it('retries a failed import once and returns the same queued row the second time', async () => {
    const queued: Array<Record<string, unknown>> = [];
    const failed = {
      id: 'old',
      orgId: 'org-1',
      itemId: 'item-1',
      layerId: 'layer',
      stagingId: 'stage',
      sourceFileName: 'notes.geojson',
      sourceLayerName: 'notes',
      mode: 'append',
      createdBy: 'user-1',
      totalFeatures: 2,
      status: 'failed',
    };
    const prisma = {
      item: { findFirst: async () => ({ id: 'item-1' }) },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      importJob: {
        findUnique: async () => failed,
        findFirst: async () => queued[0] ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: 'new', status: 'queued', errorMessage: null, ...data };
          queued.push(row);
          return row;
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          importJob: {
            findFirst: async () => queued[0] ?? null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              const row = { id: 'new', status: 'queued', errorMessage: null, ...data };
              queued.push(row);
              return row;
            },
          },
        }),
    };
    const svc = new JobsMonitorService(
      prisma as unknown as PrismaService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    const first = await svc.retry(user, 'import', 'old');
    const second = await svc.retry(user, 'import', 'old');
    expect(first.id).toBe('new');
    expect(second.id).toBe('new');
    expect(queued).toHaveLength(1);
    expect(first.type).toBe('append');
  });

  it('cancels with one conditional write and refuses a job that already finished', async () => {
    const where: unknown[] = [];
    let status = 'running';
    const prisma = {
      importJob: {
        updateMany: async (args: { where: { status: { in: string[] } } }) => {
          where.push(args.where);
          if (!args.where.status.in.includes(status)) return { count: 0 };
          status = 'cancelled';
          return { count: 1 };
        },
        findUnique: async () => ({
          id: 'job-1',
          orgId: 'org-1',
          sourceFileName: 'a.geojson',
          mode: 'append',
          status,
          errorMessage: null,
        }),
      },
    };
    const svc = new JobsMonitorService(
      prisma as unknown as PrismaService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    const first = await svc.cancel(user, 'import', 'job-1');
    expect(first.status).toBe('cancelled');
    expect(where[0]).toEqual({
      id: 'job-1',
      orgId: 'org-1',
      status: { in: ['queued', 'running'] },
    });
    await expect(svc.cancel(user, 'import', 'job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does not cancel an import in another org', async () => {
    const svc = new JobsMonitorService(
      {
        importJob: {
          updateMany: async () => ({ count: 0 }),
          findUnique: async () => ({ id: 'job-2', orgId: 'org-2', status: 'running' }),
        },
      } as unknown as PrismaService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    await expect(svc.cancel(user, 'import', 'job-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to cancel a finished backup', async () => {
    const svc = new JobsMonitorService(
      {
        backupRun: { findUnique: async () => ({ id: 'run', status: 'succeeded', trigger: 'manual', error: null }) },
      } as unknown as PrismaService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    await expect(svc.cancel(user, 'backup', 'run')).rejects.toThrow(/backup page/);
  });
});

describe('backup failure notice', () => {
  it('notifies admins once', async () => {
    const seen = new Set<string>();
    const notifyMany = jest.fn(async () => undefined);
    const prisma = {
      backupFailureNotice: {
        create: async ({ data }: { data: { runId: string } }) => {
          if (seen.has(data.runId)) throw new Error('unique');
          seen.add(data.runId);
        },
      },
      organization: { findFirst: async () => ({ id: 'org-1' }) },
      user: {
        findMany: async (args: { where?: { orgId?: string } }) => {
          if (args.where?.orgId !== 'org-1') return [];
          return [{ id: 'admin-1' }];
        },
      },
    };
    const notice = new BackupFailureNotice(
      prisma as unknown as PrismaService,
      { notifyMany } as unknown as NotificationsService,
    );
    expect(await notice.announce('run-1')).toBe(true);
    expect(await notice.announce('run-1')).toBe(false);
    expect(notifyMany).toHaveBeenCalledTimes(1);
    const call = notifyMany.mock.calls[0] as unknown[] | undefined;
    expect(call?.[1]).toBe('backup_failed');
    expect(JSON.stringify(call?.[2])).not.toContain('password');
  });
});

describe('storage reservation', () => {
  it('locks the org before it inserts a reservation', async () => {
    const sql: string[] = [];
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray) => {
        sql.push(String(strings[0]));
      },
      storageReservation: {
        findFirst: async () => null,
        create: async () => ({}),
        aggregate: async () => ({ _sum: { bytes: null } }),
      },
    };
    const prisma = {
      $transaction: async (fn: (inner: typeof tx) => Promise<void>) => fn(tx),
    };
    const svc = new ResourceQuotaService(prisma as unknown as PrismaService);
    await svc.reserve('org-1', 10n, 'upload-1');
    expect(sql.some((row) => row.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(sql.some((row) => row.includes('DELETE FROM storage_reservation'))).toBe(true);
  });
});

describe('storage reservation input', () => {
  const prisma = {
    $transaction: jest.fn(),
  };
  const svc = new ResourceQuotaService(prisma as unknown as PrismaService);

  it('refuses a purpose or org id that is not a string', async () => {
    await expect(
      svc.reserve('org-1', 1n, ['a', 'b'] as unknown as string),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.reserve({ id: 'org-1' } as unknown as string, 1n, 'upload-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('staging disk', () => {
  const saved = process.env.STAGING_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = saved;
  });

  it('measures STAGING_DIR when it is set and tmpdir otherwise', () => {
    process.env.STAGING_DIR = '  /var/lib/gg-staging ';
    expect(stagingDiskPath()).toBe('/var/lib/gg-staging');
    process.env.STAGING_DIR = '   ';
    expect(stagingDiskPath()).toBe(tmpdir());
    delete process.env.STAGING_DIR;
    expect(stagingDiskPath()).toBe(tmpdir());
  });

  function reserveWith(heldBytes: bigint | null = null) {
    const created: unknown[] = [];
    const tx = {
      $executeRaw: async () => undefined,
      storageReservation: {
        aggregate: async () => ({ _sum: { bytes: heldBytes } }),
        findFirst: async () => null,
        create: async (row: unknown) => {
          created.push(row);
          return {};
        },
      },
    };
    const prisma = {
      $transaction: async (fn: (inner: typeof tx) => Promise<void>) => fn(tx),
    };
    return { svc: new ResourceQuotaService(prisma as unknown as PrismaService), created };
  }

  it('checks free space on the STAGING_DIR filesystem', async () => {
    // A huge request against a real filesystem is refused.
    process.env.STAGING_DIR = tmpdir();
    const real = reserveWith();
    await expect(real.svc.reserve('org-1', 1n << 62n, 'upload-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The same request against a STAGING_DIR that cannot be measured
    // fails open, which shows the probe read STAGING_DIR and not tmpdir.
    process.env.STAGING_DIR = join(tmpdir(), 'gg-no-such-staging-volume-for-test');
    const missing = reserveWith();
    await missing.svc.reserve('org-1', 1n << 62n, 'upload-1');
    expect(missing.created).toHaveLength(1);
  });

  it('counts bytes other imports already hold against the free space', async () => {
    // Two imports that each fit on their own must not both pass when
    // together they do not.
    process.env.STAGING_DIR = tmpdir();
    const { statfsSync } = await import('node:fs');
    const st = statfsSync(tmpdir());
    const free = BigInt(st.bsize) * BigInt(st.bavail);
    const half = free / 2n + 1n;
    await reserveWith(0n).svc.reserve('org-1', half, 'upload-a');
    await expect(
      reserveWith(half).svc.reserve('org-2', half, 'upload-b'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a staging id that is not a UUID', async () => {
    const staging = new IngestStagingService({} as unknown as LeaderElectionService);
    for (const id of ['../../etc', '0000000-../x', 'abcdef12', '']) {
      await expect(staging.getStaging(id, 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe('maintenance hold', () => {
  it('does not clear a failed restore when acknowledgeFailure is set', async () => {
    expect(failedRestore('Restore of backup abcd failed and left the portal in an inconsistent state.')).toBe(true);
    expect(failedRestore('Turned on by an org admin.')).toBe(false);
    const deactivate = jest.fn();
    const mode = {
      snapshot: () => ({
        active: true,
        reason: 'Restore failed and left an inconsistent database',
        startedAt: null,
      }),
      deactivate,
    };
    const audits: string[] = [];
    const controller = new MaintenanceAdminController(
      mode as unknown as MaintenanceModeService,
      {
        record: async (row: { outcome: string }) => {
          audits.push(row.outcome);
        },
      } as unknown as AdminAuditService,
    );
    await expect(
      controller.set(user, { active: false, acknowledgeFailure: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deactivate).not.toHaveBeenCalled();
    expect(audits).toEqual(['failed']);
  });
});
