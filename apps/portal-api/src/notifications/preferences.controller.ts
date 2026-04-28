import {
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum } from 'class-validator';
import { NotificationChannel, NotificationType } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NOTIFICATION_TYPES,
  getTypeMeta,
} from './notification-types.js';
import { NotificationTypeDefaultService } from './notification-type-default.service.js';

class UpsertPreferenceDto {
  @IsEnum(NotificationType)
  type!: NotificationType;
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;
  @IsBoolean()
  enabled!: boolean;
}

interface PreferenceState {
  enabled: boolean;
  /** True when no row exists in notification_preference and the
   *  default from notification-types.ts is being applied. The UI
   *  uses this to render a "default" tag next to defaulted rows so
   *  users see at a glance which rows are theirs vs derived. */
  isDefault: boolean;
}

interface PreferencesPayload {
  channels: NotificationChannel[];
  types: Array<{
    type: NotificationType;
    category: string;
    label: string;
    description: string;
    channels: NotificationChannel[];
    preferences: Record<NotificationChannel, PreferenceState>;
  }>;
}

/**
 * Per-current-user notification preferences. Mounted under /users/me
 * so it lives next to the existing /users/me identity endpoint. The
 * settings UI hits these two endpoints to render the preferences
 * page.
 *
 * Storage rule: the `notification_preference` table only stores
 * divergences from the default. A user who hasn't touched the
 * settings page has zero rows. PUT-ing `enabled === default` deletes
 * any existing row so the table stays sparse over time -- a v3
 * default flip would then naturally affect every user who hadn't
 * explicitly opted out.
 *
 * Auth: every endpoint runs through the global JwtAuthGuard via
 * @CurrentUser; users only ever read / write their own preferences.
 * No admin endpoint here -- admins managing other users' preferences
 * is a Phase 3 idea, low priority.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me/notification-preferences')
export class NotificationPreferencesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly defaults: NotificationTypeDefaultService,
  ) {}

  /** Materialized per-(type, channel) state, ready for the UI to
   *  render. Combines the catalog from notification-types.ts with
   *  any user rows AND any org-wide override rows (#137). The
   *  "default" the user sees is the org default if one exists,
   *  otherwise the code default -- so when an admin mutes
   *  share_expiring platform-wide, every user with no opt-in row
   *  sees the toggle as off-by-default. */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<PreferencesPayload> {
    const [rows, overrideMap] = await Promise.all([
      this.prisma.notificationPreference.findMany({
        where: { userId: user.id },
        select: { type: true, channel: true, enabled: true },
      }),
      this.defaults.loadOverrideMap(),
    ]);
    // Build a (type, channel) -> stored row index for O(1) merge below.
    const byKey = new Map<string, boolean>();
    for (const r of rows) {
      byKey.set(`${r.type}|${r.channel}`, r.enabled);
    }
    const channels: NotificationChannel[] = ['email'];
    return {
      channels,
      types: NOTIFICATION_TYPES.map((meta) => {
        const preferences = {} as Record<NotificationChannel, PreferenceState>;
        for (const channel of meta.channels) {
          const key = `${meta.type}|${channel}`;
          const orgDefault = overrideMap.has(key)
            ? overrideMap.get(key)!
            : meta.defaultByChannel[channel];
          if (byKey.has(key)) {
            preferences[channel] = {
              enabled: byKey.get(key)!,
              isDefault: false,
            };
          } else {
            preferences[channel] = {
              enabled: orgDefault,
              isDefault: true,
            };
          }
        }
        return {
          type: meta.type,
          category: meta.category,
          label: meta.label,
          description: meta.description,
          channels: meta.channels,
          preferences,
        };
      }),
    };
  }

  /**
   * Upsert a single (type, channel) preference. When the supplied
   * `enabled` matches the default, we DELETE any existing row to
   * keep the table sparse. Otherwise upsert. Returns 204 with the
   * fresh state for that one (type, channel) so the UI can confirm
   * its optimistic update.
   */
  @Put()
  async upsert(
    @CurrentUser() user: AuthUser,
    @Body() body: UpsertPreferenceDto,
  ): Promise<PreferenceState> {
    const meta = getTypeMeta(body.type);
    if (!meta || !meta.channels.includes(body.channel)) {
      // Unknown type or channel-not-supported-for-type. Treat as a
      // no-op rather than throwing so a stale UI from before a
      // catalog change doesn't 400 the user.
      return { enabled: true, isDefault: true };
    }
    // The "default" we delete-down-to is the effective default the
    // user sees, which is the org override if any, otherwise the
    // code default. Without this fold, an admin-muted type would
    // get re-opted-in for any user who toggled then matched the
    // code default.
    const defaultEnabled = await this.defaults.effectiveDefault(
      body.type,
      body.channel,
    );
    if (body.enabled === defaultEnabled) {
      // Match default -> remove the row so this (user, type, channel)
      // tracks the default if it ever changes.
      await this.prisma.notificationPreference.deleteMany({
        where: {
          userId: user.id,
          type: body.type,
          channel: body.channel,
        },
      });
      return { enabled: defaultEnabled, isDefault: true };
    }
    await this.prisma.notificationPreference.upsert({
      where: {
        userId_type_channel: {
          userId: user.id,
          type: body.type,
          channel: body.channel,
        },
      },
      create: {
        userId: user.id,
        type: body.type,
        channel: body.channel,
        enabled: body.enabled,
      },
      update: { enabled: body.enabled },
    });
    return { enabled: body.enabled, isDefault: false };
  }
}
