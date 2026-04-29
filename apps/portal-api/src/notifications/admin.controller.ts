import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from '@prisma/client';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NOTIFICATION_TYPES, getTypeMeta } from './notification-types.js';
import { SystemSettingsService, type SmtpConfig } from './system-settings.service.js';
import { NotificationTypeDefaultService } from './notification-type-default.service.js';
import { EmailTransport } from './email-transport.js';
import { renderNotification } from './templates.js';
import { SAMPLE_PAYLOADS } from './sample-payloads.js';
import { KeycloakAdminService } from '../admin/keycloak-admin.service.js';

class SaveSmtpDto {
  @IsBoolean() enabled!: boolean;
  @IsString() host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsBoolean() secure!: boolean;
  @IsString() fromAddress!: string;
  @IsString() fromDisplayName!: string;
  @IsString() user!: string;
  /** Omit to keep the existing password; empty string to clear. */
  @IsOptional() @IsString() password?: string;
}

class TestSmtpDto {
  @IsEmail() to!: string;
  /** When provided, send the test against this unsaved config so the
   *  admin can verify before clicking Save. Optional; falls back to
   *  the stored config. */
  @IsOptional() config?: SaveSmtpDto;
}

class PutDefaultDto {
  @IsEnum(NotificationType) type!: NotificationType;
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsBoolean() enabled!: boolean;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly defaults: NotificationTypeDefaultService,
    private readonly transport: EmailTransport,
    private readonly keycloak: KeycloakAdminService,
  ) {}

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

  // ---- SMTP config (#137) ---------------------------------------

  /** Current effective SMTP config. Password is never returned --
   *  only `hasPassword` so the form can show "stored" state without
   *  leaking secret material to the browser. */
  @Get('smtp')
  async getSmtp(): Promise<SmtpStatePayload> {
    const cfg = await this.settings.getSmtpConfig();
    if (!cfg) {
      return {
        configured: false,
        enabled: false,
        host: '',
        port: 587,
        secure: false,
        fromAddress: '',
        fromDisplayName: '',
        user: '',
        hasPassword: false,
      };
    }
    return {
      configured: true,
      enabled: cfg.enabled,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      fromAddress: cfg.fromAddress,
      fromDisplayName: cfg.fromDisplayName,
      user: cfg.user,
      hasPassword: cfg.hasPassword,
    };
  }

  /**
   * Persist SMTP config. Reloads the EmailTransport so the next send
   * uses the new credentials, and re-runs the Keycloak realm SMTP
   * sync so invite / password-reset emails ride the new relay too.
   * Both reloads are best-effort: a failure here should not block
   * the admin's Save (the row is written either way).
   */
  @Put('smtp')
  async saveSmtp(
    @CurrentUser() me: AuthUser,
    @Body() dto: SaveSmtpDto,
  ): Promise<SmtpStatePayload> {
    const input: Omit<SmtpConfig, 'hasPassword'> = {
      enabled: dto.enabled,
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      fromAddress: dto.fromAddress,
      fromDisplayName: dto.fromDisplayName,
      user: dto.user,
    };
    if (dto.password !== undefined) input.password = dto.password;
    await this.settings.saveSmtpConfig(input, me.id);
    // Reload the in-process transport pool first so worker drains
    // pick up fresh creds without an api restart.
    try {
      await this.transport.reload();
    } catch {
      // Reload failures don't unwind the save -- next worker tick
      // will lazy-rebuild on demand.
    }
    // Push the new config into the Keycloak realm so invite /
    // forgot-password / verify-email emails share the relay. The
    // SMTP save itself succeeded (DB row written, in-process
    // transport reloaded) regardless of whether the realm sync
    // works -- the admin just won't get realm-issued emails (invite,
    // forgot-password, verify) through the right relay until the
    // realm-side push succeeds.
    //
    // We surface the realm-sync error as a non-blocking warning
    // on the response (#139). Before that fix, the failure was
    // logged and silently swallowed, so the admin saw a green
    // "Saved" with no idea anything had gone wrong server-side.
    let realmSyncWarning: string | undefined;
    if (this.keycloak.isConfigured()) {
      try {
        // Self-heal first: try to grant manage-realm if missing.
        // Idempotent; quiet success when already granted.
        await this.keycloak.ensureManageRealm();
      } catch {
        // Don't bail; syncRealmSmtp will surface the underlying
        // problem with a clearer error message anyway.
      }
      try {
        await this.keycloak.syncRealmSmtp();
      } catch (err) {
        realmSyncWarning =
          err instanceof Error ? err.message : String(err);
      }
    }
    const state = await this.getSmtp();
    return realmSyncWarning ? { ...state, realmSyncWarning } : state;
  }

  /**
   * One-shot test send. When `config` is provided we send through a
   * single-use transport built from those (possibly unsaved) creds
   * so the admin can verify before clicking Save; without it we use
   * the stored config.
   */
  @Post('smtp/test')
  @HttpCode(200)
  async testSmtp(@Body() dto: TestSmtpDto): Promise<{ ok: boolean; error?: string }> {
    const builtCfg: SmtpConfig | null = await (async () => {
      if (!dto.config) return this.settings.getSmtpConfig();
      const c: SmtpConfig = {
        enabled: dto.config.enabled,
        host: dto.config.host,
        port: dto.config.port,
        secure: dto.config.secure,
        fromAddress: dto.config.fromAddress,
        fromDisplayName: dto.config.fromDisplayName,
        user: dto.config.user,
        password: dto.config.password,
        hasPassword:
          typeof dto.config.password === 'string' &&
          dto.config.password.length > 0,
      };
      // If admin left password blank in the form but a stored one
      // exists, fall back to the stored value so the test exercises
      // the real config the worker would use.
      if (c.password === undefined) {
        const stored = await this.settings.getSmtpConfig();
        if (stored?.password) c.password = stored.password;
      }
      return c;
    })();
    if (!builtCfg || !builtCfg.host) {
      return { ok: false, error: 'SMTP host is empty' };
    }
    const cfg: SmtpConfig = builtCfg;
    try {
      await this.transport.sendTest(
        cfg,
        dto.to,
        'GratisGIS notifications: test email',
        'This is a test email from your GratisGIS portal. ' +
          'If you can read this, your SMTP relay is working.',
        '<p>This is a test email from your GratisGIS portal.</p>' +
          '<p>If you can read this, your SMTP relay is working.</p>',
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- Per-type org defaults (#137) -----------------------------

  @Get('defaults')
  async listDefaults(): Promise<DefaultsPayload> {
    return { rows: await this.defaults.list() };
  }

  @Put('defaults')
  async putDefault(@Body() dto: PutDefaultDto): Promise<{ ok: true }> {
    await this.defaults.setOverride(dto.type, dto.channel, dto.enabled);
    return { ok: true };
  }

  // ---- Template preview (#137) ----------------------------------

  /**
   * Render a template against a hardcoded sample payload so admins
   * can see what each notification looks like without firing a
   * real trigger. Uses PORTAL_BASE_URL / PORTAL_NAME for context
   * just like a real send.
   */
  @Get('preview/:type')
  async preview(
    @Param('type') typeRaw: string,
  ): Promise<PreviewPayload> {
    const type = typeRaw as NotificationType;
    const meta = getTypeMeta(type);
    if (!meta) {
      throw new BadRequestException(`Unknown notification type: ${typeRaw}`);
    }
    const payload = SAMPLE_PAYLOADS[type];
    if (payload === undefined) {
      throw new BadRequestException(
        `No sample payload registered for ${type}. Add one in sample-payloads.ts.`,
      );
    }
    const orgLabel = process.env.PORTAL_NAME ?? 'GratisGIS';
    const baseUrl = process.env.PORTAL_BASE_URL ?? 'http://localhost:3000';
    const rendered = renderNotification(type, payload, { orgLabel, baseUrl });
    if (!rendered) {
      throw new BadRequestException(
        `No renderer registered for ${type}. Add one in templates.ts.`,
      );
    }
    return {
      type,
      label: meta.label,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    };
  }
}

interface SmtpStatePayload {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  fromAddress: string;
  fromDisplayName: string;
  user: string;
  hasPassword: boolean;
  /**
   * Set when the SMTP save succeeded but the realm-side sync to
   * Keycloak failed. Surfaces the actionable error from
   * KeycloakAdminService.syncRealmSmtp so the admin can fix the
   * underlying issue (typically a missing manage-realm role on
   * the admin service-account) without having to dig in logs.
   * Absent / undefined when the sync succeeded or the integration
   * isn't configured. (#139)
   */
  realmSyncWarning?: string;
}

interface DefaultsPayload {
  rows: Array<{
    type: NotificationType;
    channel: NotificationChannel;
    label: string;
    category: string;
    codeDefault: boolean;
    effective: boolean;
    isOverride: boolean;
  }>;
}

interface PreviewPayload {
  type: NotificationType;
  label: string;
  subject: string;
  text: string;
  html: string;
}
