import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationStatus, NotificationType } from '@prisma/client';

import { AdminGuard } from '../admin/admin.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NOTIFICATION_TYPES } from './notification-types.js';

interface StatsPayload {
  /** Total queued + sending rows. The "in-flight" backlog. */
  queueDepth: number;
  /** Rows whose status is `failed` after exhausting retries. Stay in
   *  the table for admin inspection until manually retried or
   *  pruned. */
  failedTotal: number;
  /** Sent successfully in the last 24h. */
  sentLast24h: number;
  /** Failed in the last 24h (terminal failures, not transient ones
   *  that are still retrying). */
  failedLast24h: number;
  /** Average time from creation to delivery for rows sent in the
   *  last 24h, in milliseconds. Null when no rows were sent. */
  avgLatencyMs: number | null;
  /** Per-type rollup so admins can spot a single trigger that's
   *  flooding or failing. */
  byType: Array<{
    type: NotificationType;
    label: string;
    queued: number;
    sent: number;
    failed: number;
  }>;
}

interface RecentRow {
  id: string;
  type: NotificationType;
  status: NotificationStatus;
  address: string;
  attempts: number;
  lastError: string | null;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

/**
 * Admin-only notifications status surface (#130). Reads counts +
 * recent rows out of the `notification` table for the org admin's
 * dashboard. Also offers a per-row Retry to push a `failed` row
 * back into `queued` so the worker picks it up on its next tick
 * (used after the underlying issue is fixed, e.g. SMTP creds
 * corrected).
 *
 * Scope: this is org-wide today (no per-org filter on the query),
 * matching the rest of the admin pages. When multi-org tenancy
 * lands (#47), the queries grow an `orgId` filter and the page
 * becomes per-admin's-org.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/notifications')
export class NotificationsAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('stats')
  async stats(): Promise<StatsPayload> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Three count queries that share roughly the same shape; doing
    // them in parallel keeps the dashboard responsive even on a
    // backlog that's larger than usual.
    const [queueDepth, failedTotal, last24Sent, last24Failed] =
      await Promise.all([
        this.prisma.notification.count({
          where: {
            status: { in: ['queued', 'sending'] satisfies NotificationStatus[] },
          },
        }),
        this.prisma.notification.count({ where: { status: 'failed' } }),
        this.prisma.notification.findMany({
          where: { status: 'sent', sentAt: { gte: since24h } },
          select: { createdAt: true, sentAt: true },
        }),
        this.prisma.notification.count({
          where: { status: 'failed', createdAt: { gte: since24h } },
        }),
      ]);

    // Average latency over the sent slice. Filtering null sentAt
    // upstream means every row in last24Sent has a real timestamp.
    let avgLatencyMs: number | null = null;
    if (last24Sent.length > 0) {
      const total = last24Sent.reduce((acc, row) => {
        if (!row.sentAt) return acc;
        return acc + (row.sentAt.getTime() - row.createdAt.getTime());
      }, 0);
      avgLatencyMs = Math.round(total / last24Sent.length);
    }

    // Per-type rollup. groupBy is the cheapest path; we materialise
    // every type from the catalog so an unused type still shows
    // "0/0/0" rather than disappearing from the dashboard.
    const grouped = await this.prisma.notification.groupBy({
      by: ['type', 'status'],
      _count: { _all: true },
    });
    const byTypeMap = new Map<
      NotificationType,
      { queued: number; sent: number; failed: number }
    >();
    for (const meta of NOTIFICATION_TYPES) {
      byTypeMap.set(meta.type, { queued: 0, sent: 0, failed: 0 });
    }
    for (const g of grouped) {
      const slot = byTypeMap.get(g.type);
      if (!slot) continue;
      const count = g._count._all;
      // queued + sending fold into "in-flight" for the rollup;
      // sent and failed each get their own column.
      if (g.status === 'queued' || g.status === 'sending') {
        slot.queued += count;
      } else if (g.status === 'sent') {
        slot.sent += count;
      } else if (g.status === 'failed') {
        slot.failed += count;
      }
    }
    const byType = NOTIFICATION_TYPES.map((meta) => {
      const counts = byTypeMap.get(meta.type)!;
      return {
        type: meta.type,
        label: meta.label,
        queued: counts.queued,
        sent: counts.sent,
        failed: counts.failed,
      };
    });

    return {
      queueDepth,
      failedTotal,
      sentLast24h: last24Sent.length,
      failedLast24h: last24Failed,
      avgLatencyMs,
      byType,
    };
  }

  /**
   * Recent rows for the dashboard's "Recent activity" panel. Returns
   * the latest 50 ordered by createdAt desc, mixing every status so
   * an admin can spot a wave of failures next to the successes.
   */
  @Get('recent')
  async recent(): Promise<RecentRow[]> {
    const rows = await this.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        address: true,
        attempts: true,
        lastError: true,
        scheduledAt: true,
        sentAt: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      address: r.address,
      attempts: r.attempts,
      lastError: r.lastError,
      scheduledAt: r.scheduledAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Push a failed row back into the queue. Resets attempts to 0 so
   * the worker treats it as a fresh send (and the exponential
   * backoff doesn't kick in immediately on a row that already burned
   * its budget). scheduledAt becomes "now" so the next tick picks
   * it up. No-op when the row is already in any non-failed state --
   * keeps the action idempotent for double-clicks.
   */
  @Post(':id/retry')
  async retry(@Param('id') id: string): Promise<{ retried: boolean }> {
    const r = await this.prisma.notification.updateMany({
      where: { id, status: 'failed' },
      data: {
        status: 'queued',
        attempts: 0,
        lastError: null,
        scheduledAt: new Date(),
      },
    });
    return { retried: r.count > 0 };
  }
}
