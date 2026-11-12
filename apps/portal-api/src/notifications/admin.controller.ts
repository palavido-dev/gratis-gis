// SPDX-License-Identifier: AGPL-3.0-or-later
import { UuidPathPipe } from '../common/uuid-shape.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Optional,
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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from '@prisma/client';

import { AdminGuard } from '../admin/admin.guard.js';
import { AdminAuditService } from '../admin/admin-audit.service.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NOTIFICATION_TYPES, getTypeMeta } from './notification-types.js';
import {
  SMTP_PASSWORD_AGAIN,
  SystemSettingsService,
  sameSmtpTarget,
  type SmtpConfig,
} from './system-settings.service.js';
import { NotificationTypeDefaultService } from './notification-type-default.service.js';
import { NotificationTemplateService } from './notification-template.service.js';
import { EmailTransport } from './email-transport.js';
import {
  renderNotification,
  getTemplateVariables,
  type TemplateVariableDescriptor,
} from './templates.js';
import { SAMPLE_PAYLOADS } from './sample-payloads.js';
import { KeycloakAdminService } from '../admin/keycloak-admin.service.js';
import { textEnv } from '../common/env.js';

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

export class TestSmtpDto {
  @IsEmail() to!: string;
  /** When provided, send the test against this unsaved config so the
   *  admin can verify before clicking Save. Optional; falls back to
   *  the stored config. ValidateNested + Type make SaveSmtpDto's own
   *  rules (port range, types) run; without them none did. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaveSmtpDto)
  config?: SaveSmtpDto;
}

/**
 * What an SMTP test tells the caller. The raw error can carry the
 * first line any TCP service sends back (an SSH banner, an HTTP
 * status line), which turned the test into a port and banner probe of
 * the API's network. The full text goes to the log instead.
 */
export function describeSmtpTestError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = /^SMTP server returned (\d{3})/.exec(msg)?.[1];
  if (code === '535' || code === '530' || code === '534') {
    return `The SMTP server refused the login (${code}).`;
  }
  if (code) return `The SMTP server answered ${code} and did not accept the message.`;
  if (/timed out/i.test(msg)) return 'Timed out talking to the SMTP server.';
  return 'Could not complete an SMTP conversation with that host and port.';
}

class PutDefaultDto {
  @IsEnum(NotificationType) type!: NotificationType;
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsBoolean() enabled!: boolean;
}

class PutTemplateDto {
  @IsString() subject!: string;
  @IsString() bodyText!: string;
  @IsString() bodyHtml!: string;
}

class PreviewTemplateDto {
  @IsEnum(NotificationType) type!: NotificationType;
  @IsString() subject!: string;
  @IsString() bodyText!: string;
  @IsString() bodyHtml!: string;
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
 * Scope: the queue, SMTP relay (also pushed to the shared Keycloak
 * realm) and per-type defaults are install-wide, so those routes
 * carry OperatorOrgGuard and only admins of the operator
 * organization reach them. Templates are stored per organization
 * and stay open to every org admin.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/notifications')
export class NotificationsAdminController {
  private readonly log = new Logger('NotificationsAdmin');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly defaults: NotificationTypeDefaultService,
    private readonly templates: NotificationTemplateService,
    private readonly transport: EmailTransport,
    private readonly keycloak: KeycloakAdminService,
    @Optional() private readonly audit?: AdminAuditService,
  ) {}

  @Get('stats')
  @UseGuards(OperatorOrgGuard)
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
  @UseGuards(OperatorOrgGuard)
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
   * Push a failed or stuck-sending row back into the queue. Resets
   * attempts to 0 so the worker treats it as a fresh send (and the
   * exponential backoff doesn't kick in immediately on a row that
   * already burned its budget). scheduledAt becomes "now" so the next
   * tick picks it up. No-op when the row is already queued/sent --
   * keeps the action idempotent for double-clicks.
   *
   * `sending` is included so an admin can rescue a row stranded by a
   * sender that died mid-flight without waiting for the worker's own
   * stale-sending sweep. Clearing sendingAt keeps that sweep from also
   * acting on the row a moment later.
   */
  @Post(':id/retry')
  @UseGuards(OperatorOrgGuard)
  async retry(
    @Param('id', new UuidPathPipe('Notification not found')) id: string,
  ): Promise<{ retried: boolean }> {
    const r = await this.prisma.notification.updateMany({
      where: { id, status: { in: ['failed', 'sending'] } },
      data: {
        status: 'queued',
        attempts: 0,
        lastError: null,
        scheduledAt: new Date(),
        sendingAt: null,
      },
    });
    return { retried: r.count > 0 };
  }

  // ---- SMTP config (#137) ---------------------------------------

  /** Current effective SMTP config. Password is never returned --
   *  only `hasPassword` so the form can show "stored" state without
   *  leaking secret material to the browser. */
  @Get('smtp')
  @UseGuards(OperatorOrgGuard)
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
  @UseGuards(OperatorOrgGuard)
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
    void this.audit?.record({
      orgId: me.orgId,
      actorUserId: me.id,
      action: 'admin.smtp',
      targetType: 'smtp',
      targetId: 'install',
      outcome: 'succeeded',
      detail: {
        host: dto.host,
        port: dto.port,
        enabled: dto.enabled,
        passwordChanged: dto.password !== undefined,
        realmSynced: realmSyncWarning === undefined,
      },
    });
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
  @UseGuards(OperatorOrgGuard)
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
      // the real config the worker would use. Only for the same
      // server, port and user: sending it to any other host would
      // hand the stored password to whoever runs that host.
      if (c.password === undefined) {
        const stored = await this.settings.getSmtpConfig();
        if (stored?.password) {
          if (!sameSmtpTarget(stored, c)) {
            throw new BadRequestException(SMTP_PASSWORD_AGAIN);
          }
          c.password = stored.password;
        }
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
      this.log.warn(
        `SMTP test to ${cfg.host}:${cfg.port} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, error: describeSmtpTestError(err) };
    }
  }

  // ---- Per-type org defaults (#137) -----------------------------

  @Get('defaults')
  async listDefaults(): Promise<DefaultsPayload> {
    return { rows: await this.defaults.list() };
  }

  @Put('defaults')
  @UseGuards(OperatorOrgGuard)
  async putDefault(
    @CurrentUser() me: AuthUser,
    @Body() dto: PutDefaultDto,
  ): Promise<{ ok: true }> {
    await this.defaults.setOverride(dto.type, dto.channel, dto.enabled);
    void this.audit?.record({
      orgId: me.orgId,
      actorUserId: me.id,
      action: 'notifications.defaults',
      targetType: 'notification_type',
      targetId: `${dto.type}:${dto.channel}`,
      outcome: 'succeeded',
      detail: { enabled: dto.enabled },
    });
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
    const orgLabel = textEnv(process.env.PORTAL_NAME, 'GratisGIS');
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

  // ---- Per-org template overrides (#229 Phase B) ----------------

  /**
   * List the saved overrides for the admin's org. The admin types
   * page uses this to badge "Custom" next to types whose copy has
   * been edited. Catalog defaults are surfaced via the existing
   * /preview endpoint.
   */
  @Get('templates')
  async listTemplates(
    @CurrentUser() me: AuthUser,
  ): Promise<{ rows: Array<{ type: NotificationType; channel: NotificationChannel; isOverride: boolean; updatedAt: string | null }> }> {
    return { rows: await this.templates.list(me.orgId) };
  }

  /**
   * Read a single override, or null when none is saved. The Edit
   * modal calls this on open so it can populate the textareas with
   * the current override (or fall back to the default copy when no
   * override exists).
   */
  @Get('templates/:type/:channel')
  async getTemplate(
    @CurrentUser() me: AuthUser,
    @Param('type') typeRaw: string,
    @Param('channel') channelRaw: string,
  ): Promise<{
    override: { subject: string; bodyText: string; bodyHtml: string; updatedAt: string } | null;
    defaultPreview: { subject: string; text: string; html: string };
    /**
     * #250: per-type variable manifest for the click-to-insert
     * palette. Always at least 2 entries (orgLabel + baseUrl) even
     * for types we haven't enumerated payload vars for yet.
     */
    variables: TemplateVariableDescriptor[];
  }> {
    const type = parseType(typeRaw);
    const channel = parseChannel(channelRaw);
    const override = await this.templates.get(me.orgId, type, channel);
    const orgLabel = textEnv(process.env.PORTAL_NAME, 'GratisGIS');
    const baseUrl = process.env.PORTAL_BASE_URL ?? 'http://localhost:3000';
    // Always include a preview of the hardcoded default so the
    // editor can show "what you'll get if you click Reset".
    const payload = SAMPLE_PAYLOADS[type];
    const def =
      payload === undefined
        ? null
        : renderNotification(type, payload, { orgLabel, baseUrl });
    if (!def) {
      throw new BadRequestException(
        `No default renderer for type "${typeRaw}". Add one in templates.ts.`,
      );
    }
    return {
      override,
      defaultPreview: { subject: def.subject, text: def.text, html: def.html },
      variables: getTemplateVariables(type),
    };
  }

  /**
   * Upsert one (type, channel) override for the admin's org. The
   * payload is three mustache-lite strings; substitution happens at
   * send time. Validation here is lightweight -- a malformed
   * template still renders, just with empty substitutions, so the
   * worker doesn't get poisoned.
   */
  @Put('templates/:type/:channel')
  async putTemplate(
    @CurrentUser() me: AuthUser,
    @Param('type') typeRaw: string,
    @Param('channel') channelRaw: string,
    @Body() dto: PutTemplateDto,
  ): Promise<{ ok: true }> {
    const type = parseType(typeRaw);
    const channel = parseChannel(channelRaw);
    await this.templates.setOverride(me.orgId, type, channel, {
      subject: dto.subject,
      bodyText: dto.bodyText,
      bodyHtml: dto.bodyHtml,
    });
    void this.audit?.record({
      orgId: me.orgId,
      actorUserId: me.id,
      action: 'notifications.template',
      targetType: 'notification_template',
      targetId: `${type}:${channel}`,
      outcome: 'succeeded',
      detail: { op: 'save' },
    });
    return { ok: true };
  }

  /** Drop an override so the runtime falls back to the default. */
  @Delete('templates/:type/:channel')
  @HttpCode(204)
  async deleteTemplate(
    @CurrentUser() me: AuthUser,
    @Param('type') typeRaw: string,
    @Param('channel') channelRaw: string,
  ): Promise<void> {
    const type = parseType(typeRaw);
    const channel = parseChannel(channelRaw);
    await this.templates.clearOverride(me.orgId, type, channel);
    void this.audit?.record({
      orgId: me.orgId,
      actorUserId: me.id,
      action: 'notifications.template',
      targetType: 'notification_template',
      targetId: `${type}:${channel}`,
      outcome: 'succeeded',
      detail: { op: 'reset' },
    });
  }

  /**
   * Render an unsaved template against the type's sample payload.
   * Used by the Edit modal's live preview pane so the admin can see
   * the result of substitutions without committing.
   */
  @Post('templates/preview')
  @HttpCode(200)
  async previewTemplate(
    @Body() dto: PreviewTemplateDto,
  ): Promise<{ subject: string; text: string; html: string }> {
    const orgLabel = textEnv(process.env.PORTAL_NAME, 'GratisGIS');
    const baseUrl = process.env.PORTAL_BASE_URL ?? 'http://localhost:3000';
    const rendered = this.templates.previewUnsaved(
      { subject: dto.subject, bodyText: dto.bodyText, bodyHtml: dto.bodyHtml },
      dto.type,
      { orgLabel, baseUrl },
    );
    if (!rendered) {
      throw new BadRequestException(
        `No sample payload registered for ${dto.type}.`,
      );
    }
    return { subject: rendered.subject, text: rendered.text, html: rendered.html };
  }
}

function parseType(raw: string): NotificationType {
  if (!Object.values(NotificationType).includes(raw as NotificationType)) {
    throw new BadRequestException(`Unknown notification type: ${raw}`);
  }
  return raw as NotificationType;
}

function parseChannel(raw: string): NotificationChannel {
  if (!Object.values(NotificationChannel).includes(raw as NotificationChannel)) {
    throw new BadRequestException(`Unknown notification channel: ${raw}`);
  }
  return raw as NotificationChannel;
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
