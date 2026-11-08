// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';

import { Injectable } from '@nestjs/common';

import { operatorOrgId } from '../backup/operator-org.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAuditService } from './admin-audit.service.js';

/**
 * Support bundle for one signed-in org admin. It counts the org's
 * jobs. Only admins of the operator organization also get install
 * readiness (database, maintenance) and backup counts across every
 * org. It does not run a shell command and it does not open a path
 * the caller supplied.
 */

const SECRET_KEY = /pass|secret|token|authorization|cookie|credential|email|user.?name/i;
const SECRET_VALUE = /bearer\s+|postgres(ql)?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+/i;

export function redactDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostics(entry));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SECRET_VALUE.test(value)) return '[redacted]';
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactDiagnostics(inner);
  }
  return out;
}

function maintenanceFileActive(): boolean | null {
  const file = process.env.GRATIS_RECOVERY_MAINTENANCE_FILE;
  if (!file) return null;
  if (file.includes('\0') || file.split(/[/\\]/).includes('..')) return null;
  try {
    return existsSync(file);
  } catch {
    return null;
  }
}

async function countsBy(
  rows: Array<{ key: string; n: number }>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.key] = row.n;
  return out;
}

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async bundle(orgId: string, actorUserId: string): Promise<Record<string, unknown>> {
    const operator = (await operatorOrgId(this.prisma).catch(() => null)) === orgId;
    let database: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    const setting = await this.prisma.systemSetting
      .findUnique({ where: { key: 'maintenance' }, select: { value: true } })
      .catch(() => null);
    const value = setting?.value as { active?: unknown } | null;
    const maintenanceActive = value?.active === true || maintenanceFileActive() === true;

    const [imports, analysis, backups] = await Promise.all([
      this.prisma.importJob.groupBy({
        by: ['status'],
        where: { orgId },
        _count: { _all: true },
      }),
      this.prisma.analysisJob.groupBy({
        by: ['state'],
        where: { orgId },
        _count: { _all: true },
      }),
      operator
        ? this.prisma.backupRun.groupBy({
            by: ['status'],
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const body = {
      kind: 'gratis-admin-diagnostics',
      generatedAt: new Date().toISOString(),
      versions: {
        gg: process.env.GG_VERSION && process.env.GG_VERSION.length > 0
          ? process.env.GG_VERSION.slice(0, 80)
          : 'dev',
        node: process.version,
      },
      scope: operator ? 'install' : 'org',
      ...(operator
        ? {
            readiness: {
              database,
              maintenance: maintenanceActive,
            },
          }
        : {}),
      jobs: {
        import: await countsBy(
          imports.map((row) => ({ key: row.status, n: row._count._all })),
        ),
        analysis: await countsBy(
          analysis.map((row) => ({ key: row.state, n: row._count._all })),
        ),
      },
      ...(operator
        ? {
            backup: {
              byStatus: await countsBy(
                backups.map((row) => ({ key: row.status, n: row._count._all })),
              ),
            },
          }
        : {}),
    };
    const redacted = redactDiagnostics(body) as Record<string, unknown>;
    await this.audit.record({
      orgId,
      actorUserId,
      action: 'admin.diagnostics',
      targetType: 'diagnostics',
      targetId: orgId,
      outcome: 'succeeded',
      detail: {},
    });
    return redacted;
  }
}
