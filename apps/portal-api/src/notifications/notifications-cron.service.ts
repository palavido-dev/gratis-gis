// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * Periodic notification triggers that don't have a natural API
 * call site. share_expiring + share_expired + user_auto_disable_warning
 * all need a cron sweep because their condition is "time has elapsed
 * past a stored timestamp"; nothing the user does directly fires
 * them. user_disabled fires from the housekeeping auto-disable cron
 * via NotificationsService.notify() at the call site (this service
 * doesn't drive that one).
 *
 * Scheduling:
 *
 *   The sweep runs every 15 minutes. That's frequent enough that an
 *   expiry-warning email lands within a quarter hour of the warning
 *   window opening, infrequent enough that a busy org doesn't burn
 *   cycles re-checking. Heavy lifting (the JSONB idempotency lookups)
 *   only runs on the small candidate sets the time-window query
 *   produces, not the full share / user table.
 *
 * Idempotency:
 *
 *   We use the Notification table itself as the "have we already
 *   notified about this" check rather than adding new columns to
 *   item_share / user. For each candidate we query for an existing
 *   Notification with the matching type, recipient, and identity
 *   tuple captured in the payload (e.g. itemId + principalId +
 *   expiresAt). A re-extension of the share moves expiresAt to a
 *   new value, so the next sweep finds no prior notification with
 *   the new timestamp and re-warns the recipient. Same shape works
 *   for user_auto_disable_warning vs autoDisableAt.
 *
 *   Tradeoff: JSONB lookups aren't quite as fast as an indexed
 *   boolean column. At our target scale (thousands of shares per
 *   org, sweep runs in single-digit ms) the simplicity wins.
 *
 * Disable-the-feature switch:
 *
 *   NOTIFICATIONS_ENABLED governs the whole platform: when false,
 *   notify() is a no-op so this cron is effectively a no-op too
 *   (it still runs; the work is paid only when notify() does).
 */
const PRUNE_BATCH = 5000;

/**
 * Days a sent or failed notification is kept. Default 180. Never less
 * than twice the expiry warning window plus a day: the share sweeps
 * read old rows to avoid sending the same warning twice.
 */
export function notificationRetentionDays(
  raw: string | undefined,
  expiryWarningDays: number,
): number {
  const floor = 2 * (Number.isFinite(expiryWarningDays) ? expiryWarningDays : 7) + 1;
  const n = Number(raw);
  const asked = raw !== undefined && raw !== '' && Number.isFinite(n) ? Math.floor(n) : 180;
  return Math.max(floor, asked);
}

@Injectable()
export class NotificationsCron {
  private readonly log = new Logger(NotificationsCron.name);
  private readonly enabled: boolean;
  private readonly expiryWarningDays: number;
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly leader: LeaderElectionService,
    cfg: ConfigService,
  ) {
    this.enabled =
      (cfg.get<string>('NOTIFICATIONS_ENABLED') ?? '').toLowerCase() === 'true';
    // The warning-window-in-days for both share_expiring and
    // user_auto_disable_warning. Same setting because the user's
    // mental model is the same: "alert me a week before the thing
    // happens." Configurable for orgs that want a longer lead time
    // (e.g. 30 days for compliance contexts).
    this.expiryWarningDays = Number(
      cfg.get<string>('NOTIFICATIONS_EXPIRY_WARNING_DAYS') ?? '7',
    );
    this.retentionDays = notificationRetentionDays(
      cfg.get<string>('NOTIFICATIONS_RETENTION_DAYS'),
      this.expiryWarningDays,
    );
  }

  /**
   * Delete sent and failed rows older than the retention window, in
   * batches so a first run on a large table does not hold one long
   * delete. Queued and sending rows are never touched. Runs whether or
   * not delivery is enabled, since the table grows either way.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'notifications-retention' })
  async prune(): Promise<number> {
    if (!this.leader.shouldRun()) return 0;
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM notification
        WHERE id IN (
          SELECT id FROM notification
          WHERE created_at < ${cutoff}
            AND status IN ('sent', 'failed')
          LIMIT ${PRUNE_BATCH}
        )`;
      total += n;
      if (n < PRUNE_BATCH) break;
    }
    if (total > 0) this.log.log(`notification retention: deleted ${total} rows`);
    return total;
  }

  @Cron(CronExpression.EVERY_30_MINUTES, {
    name: 'notifications-trigger-sweep',
  })
  async tick() {
    // Multi-replica safety: only the leader sweeps. Otherwise N
    // replicas would each pump the same expiring-share + auto-
    // disable-warning rows into NotificationsService.notify(), and
    // the JSONB-payload idempotency check has a small race window
    // where two simultaneous notify() calls would both miss the
    // existing-row check and double-enqueue.
    if (!this.leader.shouldRun()) return;
    if (!this.enabled) return;
    await this.sweepExpiringShares();
    await this.sweepExpiredShares();
    await this.sweepDisableWarnings();
  }

  /** Notify recipients of shares whose expiresAt is within the
   *  warning window AND haven't already received an expiring
   *  notification for this exact expiresAt value. */
  private async sweepExpiringShares() {
    const now = new Date();
    const horizon = new Date(
      Date.now() + this.expiryWarningDays * 24 * 60 * 60 * 1000,
    );
    // gt now (still active) AND lte horizon (within warning window).
    const candidates = await this.prisma.itemShare.findMany({
      where: {
        expiresAt: { gt: now, lte: horizon },
        item: { deletedAt: null },
      },
      include: {
        item: { select: { id: true, title: true, type: true } },
      },
    });
    for (const share of candidates) {
      if (!share.expiresAt) continue;
      const recipientIds = await this.resolveShareRecipients(
        share.principalType,
        share.principalId,
      );
      for (const userId of recipientIds) {
        const expiresIso = share.expiresAt.toISOString();
        if (
          await this.alreadyNotified('share_expiring', userId, {
            itemId: share.itemId,
            principalId: share.principalId,
            expiresAt: expiresIso,
          })
        ) {
          continue;
        }
        await this.notifications.notify(userId, 'share_expiring', {
          itemId: share.itemId,
          itemTitle: share.item.title,
          itemType: share.item.type,
          expiresAt: expiresIso,
          principalType: share.principalType,
          principalId: share.principalId,
        });
      }
    }
  }

  /** Notify recipients of shares that have just expired. The "just"
   *  is enforced by the idempotency check: we only enqueue when the
   *  Notification table has no existing share_expired row for this
   *  (recipient, share, expiresAt) tuple. Shares that have been
   *  expired for ages stop firing repeat emails because the row
   *  from the first sweep stays in the table. */
  private async sweepExpiredShares() {
    const now = new Date();
    // Expired anywhere within the last warning-window. Going back
    // further is wasted work since the idempotency table holds
    // older expiries already; going forward less risks missing the
    // first sweep after a long downtime.
    const lookback = new Date(
      Date.now() - this.expiryWarningDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.prisma.itemShare.findMany({
      where: {
        expiresAt: { gt: lookback, lt: now },
        item: { deletedAt: null },
      },
      include: {
        item: { select: { id: true, title: true, type: true } },
      },
    });
    for (const share of candidates) {
      if (!share.expiresAt) continue;
      const recipientIds = await this.resolveShareRecipients(
        share.principalType,
        share.principalId,
      );
      for (const userId of recipientIds) {
        const expiresIso = share.expiresAt.toISOString();
        if (
          await this.alreadyNotified('share_expired', userId, {
            itemId: share.itemId,
            principalId: share.principalId,
            expiresAt: expiresIso,
          })
        ) {
          continue;
        }
        await this.notifications.notify(userId, 'share_expired', {
          itemId: share.itemId,
          itemTitle: share.item.title,
          itemType: share.item.type,
          expiresAt: expiresIso,
          principalType: share.principalType,
          principalId: share.principalId,
        });
      }
    }
  }

  /** Notify users whose autoDisableAt is within the warning window.
   *  Idempotent on the autoDisableAt timestamp so an admin pushing
   *  the date out triggers a fresh warning at the new date. The
   *  matching user_disabled notification fires from the housekeeping
   *  cron at the moment the row gets disabled, not from here. */
  private async sweepDisableWarnings() {
    const now = new Date();
    const horizon = new Date(
      Date.now() + this.expiryWarningDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.prisma.user.findMany({
      where: {
        orgRole: { not: 'admin' },
        autoDisableAt: { gt: now, lte: horizon },
      },
      select: { id: true, autoDisableAt: true },
    });
    for (const user of candidates) {
      if (!user.autoDisableAt) continue;
      const isoAt = user.autoDisableAt.toISOString();
      if (
        await this.alreadyNotified('user_auto_disable_warning', user.id, {
          autoDisableAt: isoAt,
        })
      ) {
        continue;
      }
      await this.notifications.notify(
        user.id,
        'user_auto_disable_warning',
        { autoDisableAt: isoAt },
      );
    }
  }

  /** Resolve user-ids for a share's principal. User principals
   *  return [principalId]; group principals fan out to current
   *  membership. Mirrors the same logic in items.service.ts so a
   *  group share fires the same set of recipients here as it did
   *  for share_created. */
  private async resolveShareRecipients(
    principalType: 'user' | 'group',
    principalId: string,
  ): Promise<string[]> {
    if (principalType === 'user') return [principalId];
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: principalId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /**
   * Check whether the Notification table already has an entry of
   * the given type for this user with payload fields matching the
   * supplied identity. A match in any non-failed status (queued /
   * sending / sent / failed) prevents re-enqueue: failed rows are
   * preserved as the audit signal that we already tried.
   *
   * Implementation uses Prisma's JSONB path query. We require ALL
   * supplied fields to match; extra fields in the stored payload
   * are ignored. Postgres jsonb_path_exists / @> would also work
   * but the AND-of-equals shape below is what Prisma exposes
   * cleanly and is plenty fast at our scale.
   */
  private async alreadyNotified(
    type:
      | 'share_expiring'
      | 'share_expired'
      | 'user_auto_disable_warning',
    userId: string,
    identity: Record<string, string>,
  ): Promise<boolean> {
    const conditions: Prisma.NotificationWhereInput[] = Object.entries(
      identity,
    ).map(([key, value]) => ({
      payload: { path: [key], equals: value },
    }));
    const existing = await this.prisma.notification.findFirst({
      where: {
        type,
        userId,
        AND: conditions,
      },
      select: { id: true },
    });
    return existing !== null;
  }
}
