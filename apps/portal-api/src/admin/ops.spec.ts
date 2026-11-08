// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { failedRestore } from './maintenance-admin.controller.js';

import { quotaDecision } from './resource-quota.js';
import { redactJobError } from './jobs-monitor.service.js';
import { JobsMonitorService } from './jobs-monitor.service.js';
import { BackupFailureNotice } from '../backup/backup-failure-notice.js';
import { CredentialRekeyService } from './credential-rekey.service.js';
import { encryptWithKey } from '../items/credential-cipher.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { AdminAuditService } from './admin-audit.service.js';
import type { BackupService } from '../backup/backup.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

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

describe('quotaDecision', () => {
  it('allows an unlimited org and refuses a full disk or a cap', () => {
    expect(
      quotaDecision({
        maxBytes: null,
        usedBytes: 0n,
        requestedBytes: 10n,
        maxConcurrentImports: null,
        activeImports: 4,
        freeBytes: 100n,
      }).ok,
    ).toBe(true);
    expect(
      quotaDecision({
        maxBytes: null,
        usedBytes: 0n,
        requestedBytes: 50n,
        maxConcurrentImports: null,
        activeImports: 0,
        freeBytes: 40n,
      }),
    ).toEqual({ ok: false, reason: 'disk' });
    expect(
      quotaDecision({
        maxBytes: 100n,
        usedBytes: 90n,
        requestedBytes: 20n,
        maxConcurrentImports: null,
        activeImports: 0,
        freeBytes: 1000n,
      }),
    ).toEqual({ ok: false, reason: 'storage' });
    expect(
      quotaDecision({
        maxBytes: null,
        usedBytes: 0n,
        requestedBytes: 0n,
        maxConcurrentImports: 1,
        activeImports: 1,
        freeBytes: 1000n,
      }),
    ).toEqual({ ok: false, reason: 'concurrent' });
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
      {} as BackupService,
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
      {} as BackupService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    const first = await svc.retry(user, 'import', 'old');
    const second = await svc.retry(user, 'import', 'old');
    expect(first.id).toBe('new');
    expect(second.id).toBe('new');
    expect(queued).toHaveLength(1);
    expect(first.type).toBe('append');
  });

  it('refuses to cancel a finished backup', async () => {
    const svc = new JobsMonitorService(
      {
        backupRun: { findUnique: async () => ({ id: 'run', status: 'succeeded', trigger: 'manual', error: null }) },
      } as unknown as PrismaService,
      {} as BackupService,
      { record: async () => undefined } as unknown as AdminAuditService,
    );
    await expect(svc.cancel(user, 'backup', 'run')).rejects.toThrow(/running backup/);
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
      user: { findMany: async () => [{ id: 'admin-1' }] },
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

describe('credential rekey', () => {
  it('rolls back when verification fails and does not claim database passwords', async () => {
    const key = randomBytes(32);
    const enc = encryptWithKey('s3cret-value', 'item-1', key);
    const rows = [
      { id: 'cred-1', itemId: 'item-1', encryptedPayload: enc.ciphertext, iv: enc.iv },
    ];
    let transactions = 0;
    const prisma = {
      itemCredential: {
        findMany: async () => rows,
        update: async () => ({}),
      },
      orgAiProvider: { findMany: async () => [], update: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        transactions += 1;
        if (transactions === 1) throw new Error('write failed');
        await fn(prisma);
      },
    };
    process.env.CREDENTIAL_ENCRYPTION_KEY = key.toString('base64');
    const { _resetKeyCacheForTests } = await import('../items/credential-cipher.js');
    _resetKeyCacheForTests();
    const audits: string[] = [];
    const svc = new CredentialRekeyService(
      prisma as unknown as PrismaService,
      { record: async (row: { outcome: string }) => { audits.push(row.outcome); } } as unknown as AdminAuditService,
    );
    expect(svc.coverage().notCovered).toEqual([
      'postgres password',
      'keycloak client secret',
      'keycloak admin secret',
      'minio root credentials',
    ]);
    const file = '/tmp/gg-rekey-key.txt';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, randomBytes(32).toString('base64'));
    process.env.GRATIS_REKEY_NEW_KEY_FILE = file;
    await expect(svc.rekey(user, 'rekey-application-credentials')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(audits).toContain('failed');
    expect(JSON.stringify(audits)).not.toContain('s3cret');
  });
});

describe('maintenance hold', () => {
  it('keeps a failed restore on until it is acknowledged', () => {
    expect(failedRestore('Restore of backup abcd failed and left the portal in an inconsistent state.')).toBe(true);
    expect(failedRestore('Turned on by an org admin.')).toBe(false);
  });
});
