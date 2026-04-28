import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Public entry point for any service that wants to notify a user.
 * Resolves the user's preferences, looks up their delivery
 * address, enqueues a Notification row per enabled channel, and
 * returns. Actual delivery happens asynchronously in the worker.
 *
 * Design decisions:
 *
 *  - Resolve the address at enqueue time (not send time). A user
 *    changing their email between trigger fire and worker drain
 *    should still receive the message at the address current when
 *    the trigger fired -- that matches "this email was correct
 *    at the moment the share was created", which is what an audit
 *    of the queue should be able to reconstruct.
 *
 *  - Preferences default to enabled when no row exists. The
 *    `notification_preference` table only stores divergences from
 *    the default, so a fresh org with no per-user prefs still
 *    gets every notification. Phase 3's settings UI writes rows
 *    only when the user opts out of something.
 *
 *  - NOTIFICATIONS_ENABLED env gates the whole platform. When
 *    false, notify() is a no-op (logs a debug line). Lets an
 *    admin who doesn't want emails in their stack flip the
 *    feature off without uninstalling code.
 *
 *  - Errors during enqueue are swallowed and logged: a failure to
 *    enqueue should NOT roll back the user-facing action that
 *    triggered it. A share creation succeeding but the
 *    notification not being queued is far better than the share
 *    creation failing because the notifications table is locked.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    cfg: ConfigService,
  ) {
    this.enabled =
      (cfg.get<string>('NOTIFICATIONS_ENABLED') ?? '').toLowerCase() === 'true';
    if (!this.enabled) {
      this.log.log(
        'NOTIFICATIONS_ENABLED is not "true"; notify() calls will be no-ops.',
      );
    }
  }

  /**
   * Enqueue notifications for one user across every channel that's
   * enabled for the given type. Phase 1 has only `email` so we
   * always end up with at most one row per call; the loop shape is
   * future-proofing for webhooks / in-app.
   */
  async notify(
    userId: string,
    type: NotificationType,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      if (!user) {
        this.log.warn(`notify: user ${userId} not found, dropping ${type}`);
        return;
      }
      // Resolve the per-(user, type, channel) preference; absence
      // of a row is "use the default" which today is always true.
      const prefs = await this.prisma.notificationPreference.findMany({
        where: { userId, type },
      });
      const prefByChannel = new Map(
        prefs.map((p) => [p.channel, p.enabled] as const),
      );

      // Phase 1: email is the only channel. Future channels iterate
      // over a list here and pick the right address per channel.
      const channels: NotificationChannel[] = ['email'];
      for (const channel of channels) {
        const enabled = prefByChannel.has(channel)
          ? prefByChannel.get(channel)!
          : defaultPreference(type, channel);
        if (!enabled) continue;
        const address = resolveAddress(channel, user);
        if (!address) {
          this.log.warn(
            `notify: no ${channel} address for user ${userId}; skipping`,
          );
          continue;
        }
        await this.prisma.notification.create({
          data: {
            userId,
            type,
            payload,
            channel,
            address,
            status: NotificationStatus.queued,
          },
        });
      }
    } catch (err) {
      // Never let a notification enqueue error roll back the
      // caller's transaction. Surface it loudly in logs and move
      // on; the queue will be empty for this trigger but the
      // user-facing operation succeeds.
      this.log.error(
        `notify(${userId}, ${type}) failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /** Convenience wrapper for fan-out cases (e.g. notifying every
   *  member of a group when their group is shared on something).
   *  Sequential enqueue rather than parallel to keep DB connection
   *  pressure bounded; in practice the fan-out is dozens, not
   *  thousands. */
  async notifyMany(
    userIds: string[],
    type: NotificationType,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    for (const id of userIds) {
      await this.notify(id, type, payload);
    }
  }
}

/**
 * Per-(type, channel) default opt-in. Today everything defaults to
 * on; the table override turns specific combinations off when the
 * user opts out via the (Phase 3) settings UI. Centralised here so
 * the service + the future preferences UI agree on the baseline.
 */
function defaultPreference(
  _type: NotificationType,
  _channel: NotificationChannel,
): boolean {
  return true;
}

/**
 * Look up the right delivery address for a channel. Email reads
 * from the user record; webhooks and in-app would read from
 * channel-specific configuration we don't have yet.
 */
function resolveAddress(
  channel: NotificationChannel,
  user: { email: string },
): string | null {
  if (channel === 'email') {
    return user.email && user.email.includes('@') ? user.email : null;
  }
  return null;
}
