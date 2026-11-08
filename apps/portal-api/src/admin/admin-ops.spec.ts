// SPDX-License-Identifier: AGPL-3.0-or-later
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { AdminAuditController } from './admin-audit.controller.js';
import {
  AdminAuditService,
  auditRetentionDays,
  sanitizeAuditDetail,
} from './admin-audit.service.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService, redactDiagnostics } from './diagnostics.service.js';
import { ReadinessController } from './readiness.controller.js';
import { analysisConfigured } from './readiness.service.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { PermissionsReportController } from './permissions-report.controller.js';
import { csvCell, permissionsToCsv, type PermissionRow } from './permissions-report.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'acme',
    username: 'ada',
    email: 'ada@example.com',
    orgRole: 'admin',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  };
}

function ctx(principal: AuthUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
  } as unknown as ExecutionContext;
}

describe('admin operation guards', () => {
  const guard = new AdminGuard();

  it.each([AdminAuditController, PermissionsReportController, DiagnosticsController])(
    'mounts AdminGuard on %p',
    (controller) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[];
      expect(guards).toContain(AdminGuard);
    },
  );

  it('refuses an API key on the shared admin guard', () => {
    expect(() =>
      guard.canActivate(ctx(user({ authKind: 'api_key' }))),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(ctx(user({ authKind: 'api_key' }))),
    ).toThrow(/API keys cannot be used on admin endpoints/);
  });

  it('refuses a viewer', () => {
    expect(() => guard.canActivate(ctx(user({ orgRole: 'viewer' })))).toThrow(
      ForbiddenException,
    );
  });
});

describe('sanitizeAuditDetail', () => {
  it('drops secrets, email, and request-shaped values', () => {
    const detail = sanitizeAuditDetail({
      role: 'admin',
      enabled: false,
      password: 'hunter2',
      token: 'abc',
      email: 'ada@example.com',
      note: 'ada@example.com',
      body: { raw: true },
      connection: 'postgresql://user:pass@db/gratis',
      from: 'private',
      to: 'org',
    });
    expect(detail).toEqual({ role: 'admin', enabled: false, from: 'private', to: 'org' });
    expect(JSON.stringify(detail)).not.toContain('hunter2');
    expect(JSON.stringify(detail)).not.toContain('ada@');
    expect(JSON.stringify(detail)).not.toContain('postgresql');
  });
});

describe('AdminAuditService', () => {
  function harness() {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      adminAuditEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `id-${rows.length + 1}`,
            at: new Date('2026-11-08T12:00:00.000Z'),
            ...data,
          };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(async ({ where }: { where: { orgId: string } }) =>
          rows.filter((row) => row.orgId === where.orgId),
        ),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    return { svc: new AdminAuditService(prisma as unknown as PrismaService), rows, prisma };
  }

  it('stores an event for the caller org only', async () => {
    const { svc, rows } = harness();
    await svc.record({
      orgId: 'org-a',
      actorUserId: 'user-1',
      action: 'user.role',
      targetType: 'user',
      targetId: 'user-2',
      outcome: 'succeeded',
      detail: { role: 'admin', password: 'nope' },
    });
    await svc.record({
      orgId: 'org-b',
      actorUserId: 'user-9',
      action: 'user.delete',
      targetType: 'user',
      targetId: 'user-8',
      outcome: 'succeeded',
    });
    const page = await svc.list('org-a');
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.action).toBe('user.role');
    expect(page.events[0]?.detail).toEqual({ role: 'admin' });
    expect(rows).toHaveLength(2);
  });

  it('clamps retention to at least 30 days', () => {
    expect(auditRetentionDays('1')).toBe(30);
    expect(auditRetentionDays('not-a-number')).toBe(400);
  });

  it('keeps the 400-day default when Compose passes an empty value', () => {
    expect(auditRetentionDays('')).toBe(400);
    expect(auditRetentionDays('  ')).toBe(400);
    expect(auditRetentionDays(undefined)).toBe(400);
  });

  it('reports analysis from ANALYSIS_TIERS, the switch the API obeys', () => {
    expect(analysisConfigured('server-heavy')).toBe('on');
    expect(analysisConfigured('')).toBe('off');
    expect(analysisConfigured(undefined)).toBe('off');
  });
});

describe('permissions CSV', () => {
  it('neutralises formula cells and labels the snapshot', () => {
    const row: PermissionRow = {
      itemId: 'item-1',
      title: '=cmd|" /C calc"!A0',
      itemType: 'map',
      access: 'org',
      ownerId: 'user-1',
      ownerUsername: 'ada',
      ownerMissing: false,
      principalType: 'user',
      principalId: 'user-2',
      permission: 'edit',
      principalMissing: true,
    };
    const csv = permissionsToCsv([row]);
    expect(csv.startsWith('snapshot,itemId,')).toBe(true);
    expect(csv).toContain("'=cmd|");
    expect(csv).toContain('\ncurrent,');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@sum')).toBe("'@sum");
  });
});

describe('diagnostics redaction', () => {
  it('removes secrets and identities and does not spawn a shell', async () => {
    const redacted = redactDiagnostics({
      versions: { gg: 'dev' },
      password: 'hunter2',
      nested: { email: 'ada@example.com', database: 'ok' },
      reason: 'postgresql://gratis:secret@db/app $(rm -rf /)',
    }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ada@');
    expect(text).not.toContain('postgresql');
    expect(text).not.toContain('rm -rf');
    expect(redacted.password).toBe('[redacted]');

    const created: unknown[] = [];
    const prisma = {
      $queryRaw: jest.fn(async () => [{ one: 1 }]),
      systemSetting: { findUnique: jest.fn(async () => ({ value: { active: false } })) },
      importJob: { groupBy: jest.fn(async () => [{ status: 'failed', _count: { _all: 2 } }]) },
      analysisJob: { groupBy: jest.fn(async () => []) },
      backupRun: { groupBy: jest.fn(async () => [{ status: 'succeeded', _count: { _all: 1 } }]) },
      organization: { findFirst: jest.fn(async () => ({ id: 'org-1' })) },
    };
    const audit = { record: jest.fn(async (row) => { created.push(row); }) };
    const bundle = await new DiagnosticsService(
      prisma as unknown as PrismaService,
      audit as unknown as AdminAuditService,
    ).bundle('org-1', 'user-1');
    expect(bundle.kind).toBe('gratis-admin-diagnostics');
    expect(bundle.scope).toBe('install');
    expect((bundle.readiness as { database: string }).database).toBe('ok');
    expect((bundle.backup as { byStatus: { succeeded: number } }).byStatus.succeeded).toBe(1);
    expect((bundle.jobs as { import: { failed: number } }).import.failed).toBe(2);
    expect(JSON.stringify(bundle)).not.toContain('user-1');
    expect(created).toHaveLength(1);
  });
});

describe('install-wide admin data', () => {
  it('limits readiness to the operator organization', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ReadinessController) as unknown[];
    expect(guards).toEqual([AdminGuard, OperatorOrgGuard]);
  });

  it('leaves backup counts and readiness out of a non-operator bundle', async () => {
    const backupGroupBy = jest.fn(async () => [{ status: 'succeeded', _count: { _all: 1 } }]);
    const prisma = {
      $queryRaw: jest.fn(async () => [{ one: 1 }]),
      systemSetting: { findUnique: jest.fn(async () => null) },
      importJob: { groupBy: jest.fn(async () => [{ status: 'queued', _count: { _all: 3 } }]) },
      analysisJob: { groupBy: jest.fn(async () => []) },
      backupRun: { groupBy: backupGroupBy },
      organization: { findFirst: jest.fn(async () => ({ id: 'org-operator' })) },
    };
    const bundle = await new DiagnosticsService(
      prisma as unknown as PrismaService,
      { record: jest.fn(async () => undefined) } as unknown as AdminAuditService,
    ).bundle('org-2', 'user-2');
    expect(bundle.scope).toBe('org');
    expect(bundle).not.toHaveProperty('backup');
    expect(bundle).not.toHaveProperty('readiness');
    expect(backupGroupBy).not.toHaveBeenCalled();
    expect((bundle.jobs as { import: { queued: number } }).import.queued).toBe(3);
  });
});
