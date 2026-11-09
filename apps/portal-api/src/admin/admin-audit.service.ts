// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Org admin audit. Rows are written when a privileged action
 * finishes. This table is not the feature observation log: an edit
 * to a map feature does not land here, and this log is not a history
 * of those edits.
 *
 * Stored fields are ids, an action name, an outcome, and a small
 * detail object. Passwords, tokens, request bodies, and email
 * addresses are dropped before insert.
 */

export const AUDIT_ACTIONS = [
  'user.invite',
  'user.role',
  'user.enabled',
  'user.auto_disable',
  'user.delete',
  'user.password_reset',
  'user.capability',
  'item.access',
  'item.share',
  'item.unshare',
  'item.owner',
  'backup.config',
  'backup.run',
  'backup.restore',
  'backup.cancel',
  'backup.delete',
  'admin.security',
  'admin.branding',
  'admin.diagnostics',
  'job.cancel',
  'job.retry',
  'maintenance.set',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = 'succeeded' | 'failed' | 'denied';

// Callers use camelCase (ownerId, principalType). Lower-case only
// silently dropped those, so owner and share events lost who got access.
const DETAIL_KEY = /^[a-z][A-Za-z0-9_]{0,40}$/;
const SECRET_KEY = /pass|secret|token|authorization|cookie|body|email|credential/i;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuditWrite {
  orgId: string;
  actorUserId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

export interface AuditEventOut {
  id: string;
  at: string;
  actorUserId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  detail: Record<string, string | number | boolean>;
}

const DEFAULT_RETENTION_DAYS = 400;

export function auditRetentionDays(raw = process.env.GRATIS_ADMIN_AUDIT_RETENTION_DAYS): number {
  // Compose passes an unset setting as an empty string. Number('') is
  // 0, which would clamp to the 30-day floor and purge a year of audit.
  if (!raw?.trim()) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(3650, Math.max(30, Math.floor(n)));
}

/** Keep only short scalar facts. Drop anything that looks like a secret. */
export function sanitizeAuditDetail(
  input: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!DETAIL_KEY.test(key) || SECRET_KEY.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, 80);
    if (trimmed.length === 0 || EMAILISH.test(trimmed)) continue;
    if (/bearer\s+|postgres(ql)?:\/\//i.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

@Injectable()
export class AdminAuditService {
  private readonly log = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditWrite): Promise<void> {
    try {
      await this.prisma.adminAuditEvent.create({
        data: {
          orgId: input.orgId,
          actorUserId: input.actorUserId,
          action: input.action,
          targetType: input.targetType.slice(0, 40),
          targetId: input.targetId.slice(0, 80),
          outcome: input.outcome,
          detail: sanitizeAuditDetail(input.detail),
        },
      });
      await this.prune(input.orgId);
    } catch (err) {
      this.log.warn('admin audit write failed');
      void err;
    }
  }

  async list(
    orgId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<{ events: AuditEventOut[]; nextBefore: string | null }> {
    await this.prune(orgId);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const cursor = parseCursor(opts.before);
    const rows = await this.prisma.adminAuditEvent.findMany({
      where: {
        orgId,
        ...(cursor
          ? {
              OR: [
                { at: { lt: cursor.at } },
                { at: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actorUserId: row.actorUserId,
        action: row.action as AuditAction,
        targetType: row.targetType,
        targetId: row.targetId,
        outcome: row.outcome as AuditOutcome,
        detail: sanitizeAuditDetail(row.detail as Record<string, unknown>),
      })),
      nextBefore:
        rows.length > limit && last
          ? `${last.at.toISOString()}|${last.id}`
          : null,
    };
  }

  async prune(orgId: string): Promise<number> {
    const days = auditRetentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.adminAuditEvent.deleteMany({
      where: { orgId, at: { lt: cutoff } },
    });
    return result.count;
  }
}

function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const split = raw.indexOf('|');
  if (split < 1) return null;
  const at = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (!Number.isFinite(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}
