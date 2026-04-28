import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { EmailTransport } from './email-transport.js';
import { renderNotification, type RenderContext } from './templates.js';

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
    if (!this.enabled) return;
    if (this.busy) {
      // Previous tick still in flight (slow SMTP, big batch). Skip
      // this tick rather than overlap; the next one is 30s away.
      return;
    }
    if (!this.transport.isAvailable()) {
      // SMTP misconfigured. Logged once per process by EmailTransport;
      // we silently skip ticks until env is fixed.
      return;
    }
    this.busy = true;
    try {
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
      data: { status: NotificationStatus.sending },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (!row) return;

    // Phase 1: only email is wired. Other channels would dispatch
    // here based on row.channel.
    const rendered = renderNotification(row.type, row.payload, this.renderCtx);
    if (!rendered) {
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.failed,
          lastError: `No template registered for type "${row.type}"`,
          attempts: { increment: 1 },
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
        },
      });
      this.log.warn(
        `Notification ${id} attempt ${nextAttempts} failed: ${message}` +
          (isFinal ? ' (final, marked failed)' : ' (will retry)'),
      );
    }
  }
}
