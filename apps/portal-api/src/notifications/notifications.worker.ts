// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { EmailTransport } from './email-transport.js';
import { NotificationTemplateService } from './notification-template.service.js';
import { renderNotification, type RenderContext } from './templates.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * Drains the notification queue in batches. Runs on a 30-second
 * cron when notifications are enabled; that's frequent enough that
 * a share-created email lands within seconds without pushing
 * server load. Phase 2 may swap to a listen/notify or Redis-backed
 * queue if the polling overhead becomes meaningful, but at the
 * scale we're targeting (hundreds of queued items per day on a
 * single org) polling is by far the simplest correct thing.
 *
 * Retry strategy:
 *
 *   - Each attempt that fails records lastError and bumps attempts.
 *   - scheduledAt slides forward by exponential backoff
 *     (60s, 5m, 30m, 2h, 12h) so failed messages naturally pace
 *     themselves out without us building a separate retry table.
 *   - After MAX_ATTEMPTS, the row stops attempting; admins can
 *     inspect or retry manually via the Phase 2 admin UI.
 *
 * Concurrency: the worker is single-instance per api process and
 * the cron uses a guard flag to skip a tick when the previous one
 * is still in flight. Multi-instance deploys with multiple workers
 * would need row-level locking (SELECT ... FOR UPDATE SKIP LOCKED);
 * not needed today, called out as a TODO so a future scale-out
 * doesn't quietly double-send.
 */
/**
 * A row claimed queued -> sending whose sendingAt is older than this is
 * treated as stranded by a dead sender and reclaimed. Generous on
 * purpose: a real SMTP send resolves in seconds, so fifteen minutes of
 * a row sitting in `sending` means the process that claimed it died
 * before writing a terminal state. The wide margin also bounds the
 * at-least-once risk (see reclaimStaleSending).
 */
const SENDING_RECLAIM_AFTER_MS = 15 * 60_000;

@Injectable()
export class NotificationsWorker {
  private readonly log = new Logger(NotificationsWorker.name);
  private busy = false;
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly renderCtx: RenderContext;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: EmailTransport,
    private readonly cfg: ConfigService,
    private readonly templates: NotificationTemplateService,
    private readonly leader: LeaderElectionService,
  ) {
    this.enabled =
      (this.cfg.get<string>('NOTIFICATIONS_ENABLED') ?? '').toLowerCase() ===
      'true';
    this.batchSize = Number(
      this.cfg.get<string>('NOTIFICATIONS_BATCH_SIZE') ?? '25',
    );
    this.maxAttempts = Number(
      this.cfg.get<string>('NOTIFICATIONS_MAX_ATTEMPTS') ?? '5',
    );
    this.renderCtx = {
      orgLabel: this.cfg.get<string>('PORTAL_NAME') ?? 'GratisGIS',
      baseUrl:
        (this.cfg.get<string>('PORTAL_BASE_URL') ?? 'http://localhost:3000').replace(
          /\/$/,
          '',
        ),
    };
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'notifications-drain' })
  async tick() {
    // Multi-replica safety: only the leader drains the queue. Without
    // this every replica's tick would race the same submitted-rows
    // window and SMTP-send the same notification N times. The class
    // doc above flagged this as a future TODO; it's now enforced.
    if (!this.leader.shouldRun()) return;
    if (!this.enabled) return;
    if (this.busy) {
      // Previous tick still in flight (slow SMTP, big batch). Skip
      // this tick rather than overlap; the next one is 30s away.
      return;
    }
    if (!(await this.transport.isAvailable())) {
      // SMTP misconfigured. Logged once per process by EmailTransport;
      // we silently skip ticks until the admin saves SMTP via
      // /admin/notifications and the transport reload picks it up.
      return;
    }
    this.busy = true;
    try {
      // Reclaim first, so anything a dead sender stranded in `sending`
      // is back to `queued` before this tick's drain and goes out now
      // rather than a tick later.
      await this.reclaimStaleSending();
      await this.drainBatch();
    } catch (err) {
      this.log.error(
        `Drain batch failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.busy = false;
    }
  }

  /**
   * Rescue rows stranded in `sending`.
   *
   * `processOne` claims a row by flipping queued -> sending, then sends,
   * then writes a terminal state. A process that dies in that window
   * leaves the row at `sending` forever: `drainBatch` selects only
   * `queued`, so it never comes back, and the admin retry only touches
   * `failed`. This sweep, running under the same leader gate as the
   * drain, moves a stale `sending` row back to `queued` (still
   * retryable) or to `failed` (budget already spent).
   *
   * At-least-once by construction: a row that was actually sent but
   * crashed before the DB write will send again. That is the right
   * trade for notifications (a rare duplicate email beats a silently
   * dropped one), and the 15-minute threshold keeps a still-in-flight
   * send from being reclaimed out from under a slow transport. Every
   * update is guarded on status='sending' so it cannot disturb a row
   * that has since reached a terminal state.
   */
  private async reclaimStaleSending() {
    const cutoff = new Date(Date.now() - SENDING_RECLAIM_AFTER_MS);
    const requeued = await this.prisma.notification.updateMany({
      where: {
        status: NotificationStatus.sending,
        sendingAt: { lt: cutoff },
        attempts: { lt: this.maxAttempts },
      },
      data: {
        status: NotificationStatus.queued,
        scheduledAt: new Date(),
        sendingAt: null,
        lastError: 'Sending was interrupted before it completed; requeued.',
      },
    });
    // Belt and braces: a row whose retry budget is already spent cannot
    // be requeued (drainBatch caps at attempts < maxAttempts, so it
    // would sit in `sending` forever). Fail it instead.
    const failed = await this.prisma.notification.updateMany({
      where: {
        status: NotificationStatus.sending,
        sendingAt: { lt: cutoff },
        attempts: { gte: this.maxAttempts },
      },
      data: {
        status: NotificationStatus.failed,
        sendingAt: null,
        lastError:
          'Sending was interrupted after the retry budget was exhausted.',
      },
    });
    const n = requeued.count + failed.count;
    if (n > 0) {
      this.log.warn(`Reclaimed ${n} notification(s) stranded in 'sending'.`);
    }
  }

  /**
   * Pull up to batchSize queued rows whose scheduledAt has elapsed
   * and process them sequentially. Sequential rather than parallel
   * because nodemailer's SMTP transport is connection-pooled but
   * each outbound message still serializes on the connection;
   * parallelism here doesn't buy speed and complicates failure
   * accounting.
   */
  private async drainBatch() {
    const due = await this.prisma.notification.findMany({
      where: {
        status: NotificationStatus.queued,
        scheduledAt: { lte: new Date() },
        attempts: { lt: this.maxAttempts },
      },
      orderBy: { scheduledAt: 'asc' },
      take: this.batchSize,
    });
    if (due.length === 0) return;
    this.log.debug(`Draining ${due.length} notification(s)`);
    for (const row of due) {
      await this.processOne(row.id);
    }
  }

  /**
   * Attempt one row end to end:
   *
   *   1. Move row to `sending` (single-row guard so other workers --
   *      hypothetical, for now -- skip it).
   *   2. Render subject/body via the type's template.
   *   3. Send via the configured transport.
   *   4. On success: mark `sent` with sentAt.
   *   5. On failure: bump attempts, push scheduledAt forward by
   *      backoff, mark `queued` again so the next tick picks it
   *      up. After maxAttempts, leave it `failed` permanently.
   */
  private async processOne(id: string) {
    // Lock the row by flipping status. If it already moved (e.g.
    // an admin requeued it) we just skip.
    const claimed = await this.prisma.notification.updateMany({
      where: { id, status: NotificationStatus.queued },
      // Stamp sendingAt so the reclaim sweep can tell a genuinely
      // in-flight send from one whose sender died mid-flight.
      data: { status: NotificationStatus.sending, sendingAt: new Date() },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (!row) return;

    // Phase 1: only email is wired. Other channels would dispatch
    // here based on row.channel.
    //
    // Render precedence (#229 Phase B): per-org notification_template
    // override > hardcoded default in templates.ts. The override
    // path needs the recipient's orgId, which we read off the User
    // row. Lookup is one extra row per send; given we drain in
    // batches of 25 once every 30s that's negligible.
    let rendered = null as Awaited<
      ReturnType<typeof renderNotification>
    > | null;
    const recipient = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { orgId: true },
    });
    if (recipient?.orgId) {
      rendered = await this.templates.renderOverride(
        recipient.orgId,
        row.type,
        row.channel,
        row.payload,
        this.renderCtx,
      );
    }
    if (!rendered) {
      rendered = renderNotification(row.type, row.payload, this.renderCtx);
    }
    if (!rendered) {
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.failed,
          lastError: `No template registered for type "${row.type}"`,
          attempts: { increment: 1 },
          sendingAt: null,
        },
      });
      this.log.warn(
        `Notification ${id} type=${row.type} has no template; marked failed`,
      );
      return;
    }

    try {
      await this.transport.send({
        to: row.address,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.sent,
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
          sendingAt: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;
      const isFinal = nextAttempts >= this.maxAttempts;
      // Backoff in milliseconds: 60s, 5m, 30m, 2h, 12h. The index
      // is the attempt-just-completed; if next attempt would still
      // be retryable, push scheduledAt forward by the matching
      // delay. The last entry is reused if we somehow exceed it.
      const backoffMs = [
        60_000,
        5 * 60_000,
        30 * 60_000,
        2 * 60 * 60_000,
        12 * 60 * 60_000,
      ];
      const delay =
        backoffMs[Math.min(nextAttempts - 1, backoffMs.length - 1)] ??
        backoffMs[backoffMs.length - 1]!;
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: isFinal
            ? NotificationStatus.failed
            : NotificationStatus.queued,
          attempts: { increment: 1 },
          // Truncate at ~1KB so a verbose SMTP error doesn't blow
          // up the row size.
          lastError: message.slice(0, 1024),
          scheduledAt: isFinal ? row.scheduledAt : new Date(Date.now() + delay),
          sendingAt: null,
        },
      });
      this.log.warn(
        `Notification ${id} attempt ${nextAttempts} failed: ${message}` +
          (isFinal ? ' (final, marked failed)' : ' (will retry)'),
      );
    }
  }
}
