// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import {
  SystemSettingsService,
  type SmtpConfig,
} from './system-settings.service.js';
import { sendSmtpMail } from './smtp-client.js';

/**
 * Email transport sourced from SystemSettingsService (#137). The
 * DB row written by the admin /admin/notifications SMTP form is
 * the source of truth; env vars (SMTP_HOST etc.) act as a seed
 * for fresh deployments before the admin saves anything.
 *
 * Backed by a vendored minimal SMTP client (#48) rather than
 * nodemailer. One connection per message, no pooling -- a
 * GratisGIS portal sends low-enough volume that pooling didn't
 * move the needle, and dropping the dep saves the ~450 KB of
 * nodemailer + its 30 transitive subdeps.
 */
@Injectable()
export class EmailTransport {
  private readonly log = new Logger(EmailTransport.name);
  private cachedFrom: string = 'GratisGIS <noreply@gratisgis.local>';
  /** host:port:secure last logged, so a config change is logged once. */
  private lastLogged = '';

  constructor(private readonly settings: SystemSettingsService) {}

  /**
   * Resolve the active SMTP config on every use. SystemSettingsService
   * holds the short-lived cache, so a save on another replica reaches
   * this one within its TTL. Returns null when delivery is disabled /
   * misconfigured so callers can degrade gracefully (the worker logs +
   * drops the notification rather than crashing the api).
   */
  private async getConfig(): Promise<SmtpConfig | null> {
    const cfg = await this.settings.getSmtpConfig();
    if (!cfg || !cfg.enabled) return null;
    if (!cfg.host) {
      this.log.warn(
        'SMTP enabled but no host configured; email delivery disabled.',
      );
      return null;
    }
    if (!Number.isFinite(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      this.log.warn(
        `SMTP port=${cfg.port} is invalid; email delivery disabled.`,
      );
      return null;
    }
    this.cachedFrom = formatFrom(cfg);
    const key = `${cfg.host}:${cfg.port}:${cfg.secure}`;
    if (key !== this.lastLogged) {
      this.lastLogged = key;
      this.log.log(
        `SMTP transport configured: host=${cfg.host} port=${cfg.port} secure=${cfg.secure}`,
      );
    }
    return cfg;
  }

  /** True when the active config is good enough to attempt delivery. */
  async isAvailable(): Promise<boolean> {
    return (await this.getConfig()) !== null;
  }

  /**
   * Reload the transport from current settings -- invoked by the
   * admin save endpoint so the very next send uses the new
   * config. No pool to close anymore (one connection per send),
   * just drop the cached config and let the next send re-read.
   */
  async reload(): Promise<void> {
    this.settings.invalidateSmtpCache();
    // Eagerly re-read so the next send is hot.
    await this.getConfig();
  }

  /**
   * Deliver a single message. Throws on transport-level failure
   * so the worker can record the error and decide whether to
   * retry. Caller is responsible for not calling when
   * isAvailable() is false (the worker guards on this).
   */
  async send(opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg) {
      throw new Error('SMTP transport not configured');
    }
    await sendSmtpMail(
      {
        host: cfg.host!,
        port: cfg.port,
        secure: cfg.secure,
        ...(cfg.user ? { user: cfg.user, password: cfg.password ?? '' } : {}),
        allowPlaintextAuth: process.env.SMTP_ALLOW_PLAINTEXT_AUTH === 'true',
      },
      {
        from: this.cachedFrom,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      },
    );
  }

  /**
   * One-shot test send that bypasses the worker entirely. Used
   * by /admin/notifications/smtp/test so admins can verify the
   * config without enqueueing a real notification. Reads the
   * supplied (possibly unsaved) config so the admin can hit
   * Send test before clicking Save.
   */
  async sendTest(
    cfg: SmtpConfig,
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    if (!cfg.host) throw new Error('SMTP host is empty');
    await sendSmtpMail(
      {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        ...(cfg.user ? { user: cfg.user, password: cfg.password ?? '' } : {}),
        allowPlaintextAuth: process.env.SMTP_ALLOW_PLAINTEXT_AUTH === 'true',
      },
      {
        from: formatFrom(cfg),
        to,
        subject,
        text,
        html,
      },
    );
  }
}

export function formatFrom(cfg: SmtpConfig): string {
  if (!cfg.fromAddress) return 'GratisGIS <noreply@gratisgis.local>';
  if (cfg.fromDisplayName) {
    return `${displayNamePhrase(cfg.fromDisplayName)} <${cfg.fromAddress}>`;
  }
  return cfg.fromAddress;
}

/**
 * A From display name as an RFC 5322 phrase. Unquoted, a comma made
 * "City of Springfield, GIS" two mailboxes, which strict receivers
 * reject; non-ASCII went out as raw 8-bit header bytes. ASCII is
 * quoted, anything else is RFC 2047 encoded.
 */
function displayNamePhrase(name: string): string {
  const flat = name.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(flat)) {
    return `"${flat.replace(/(["\\])/g, '\\$1')}"`;
  }
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}
