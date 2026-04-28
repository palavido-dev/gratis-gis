import { Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  NOTIFICATION_TYPES,
  getTypeMeta,
} from './notification-types.js';

/**
 * Per-(NotificationType, NotificationChannel) org-wide default
 * service (#137). Wraps the `notification_type_default` table and
 * implements the precedence chain a runtime evaluator needs:
 *
 *   user notification_preference  >  org notification_type_default  >  code default
 *
 * Sparse-write contract: a row that matches the code default is
 * deleted so the table stays minimal -- a future code-default flip
 * naturally affects every (org, type, channel) combo that hasn't
 * been overridden.
 */
@Injectable()
export class NotificationTypeDefaultService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Effective default for a (type, channel). Resolves the override
   * with a single point lookup; falls back to the code default when
   * no row exists.
   */
  async effectiveDefault(
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const row = await this.prisma.notificationTypeDefault.findUnique({
      where: { type_channel: { type, channel } },
    });
    if (row) return row.enabled;
    const meta = getTypeMeta(type);
    if (!meta) return true;
    return meta.defaultByChannel[channel] ?? true;
  }

  /**
   * Bulk version of effectiveDefault used by NotificationsService at
   * dispatch time. Returns a Map keyed by `${type}|${channel}` so
   * the caller can mix code-default and override lookups in one
   * pass.
   */
  async loadOverrideMap(): Promise<Map<string, boolean>> {
    const rows = await this.prisma.notificationTypeDefault.findMany();
    return new Map(rows.map((r) => [`${r.type}|${r.channel}`, r.enabled]));
  }

  /**
   * Materialised list for the admin page: every (type, channel) the
   * catalog declares, with code default + current effective default
   * + a flag indicating whether it's an admin override.
   */
  async list(): Promise<
    Array<{
      type: NotificationType;
      channel: NotificationChannel;
      label: string;
      category: string;
      codeDefault: boolean;
      effective: boolean;
      isOverride: boolean;
    }>
  > {
    const overrides = await this.loadOverrideMap();
    const out: Array<{
      type: NotificationType;
      channel: NotificationChannel;
      label: string;
      category: string;
      codeDefault: boolean;
      effective: boolean;
      isOverride: boolean;
    }> = [];
    for (const meta of NOTIFICATION_TYPES) {
      for (const channel of meta.channels) {
        const codeDefault = meta.defaultByChannel[channel] ?? true;
        const overrideKey = `${meta.type}|${channel}`;
        const isOverride = overrides.has(overrideKey);
        const effective = isOverride
          ? overrides.get(overrideKey)!
          : codeDefault;
        out.push({
          type: meta.type,
          channel,
          label: meta.label,
          category: meta.category,
          codeDefault,
          effective,
          isOverride,
        });
      }
    }
    return out;
  }

  /**
   * Upsert one (type, channel) override. When `enabled` matches the
   * code default we delete the row to keep the table sparse -- same
   * trick the per-user notification_preference table uses, for the
   * same reason.
   */
  async setOverride(
    type: NotificationType,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<void> {
    const meta = getTypeMeta(type);
    if (!meta || !meta.channels.includes(channel)) return;
    const codeDefault = meta.defaultByChannel[channel] ?? true;
    if (enabled === codeDefault) {
      await this.prisma.notificationTypeDefault.deleteMany({
        where: { type, channel },
      });
      return;
    }
    await this.prisma.notificationTypeDefault.upsert({
      where: { type_channel: { type, channel } },
      create: { type, channel, enabled },
      update: { enabled },
    });
  }
}
