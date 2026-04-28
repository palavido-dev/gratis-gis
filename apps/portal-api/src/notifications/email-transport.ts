import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

import {
  SystemSettingsService,
  type SmtpConfig,
} from './system-settings.service.js';

/**
 * Thin nodemailer wrapper sourced from SystemSettingsService (#137).
 * The DB row written by the admin /admin/notifications SMTP form is
 * the source of truth; env vars (SMTP_HOST etc.) act as a seed for
 * fresh deployments before the admin saves anything.
 *
 * Connection pooling is on by default; nodemailer keeps a small pool
 * of authenticated SMTP connections open and reuses them across
 * messages. The pool is rebuilt whenever reload() is called -- which
 * the admin save endpoint triggers so the next send picks up new
 * creds without an api restart.
 */
@Injectable()
export class EmailTransport {
  private readonly log = new Logger(EmailTransport.name);
  private transporter: Transporter | null = null;
  private cachedFrom: string = 'GratisGIS <noreply@gratisgis.local>';

  constructor(private readonly settings: SystemSettingsService) {}

  /**
   * Lazily build the transporter on first send (or on reload after an
   * admin save). Defers any "is the SMTP host reachable" failure to
   * the moment the worker actually has something to deliver, rather
   * than at api boot where a misconfigured SMTP would crash startup
   * for everyone.
   */
  private async getTransporter(): Promise<Transporter | null> {
    if (this.transporter) return this.transporter;
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
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user
        ? { auth: { user: cfg.user, pass: cfg.password ?? '' } }
        : {}),
      pool: true,
    });
    this.log.log(
      `SMTP transport configured: host=${cfg.host} port=${cfg.port} secure=${cfg.secure}`,
    );
    return this.transporter;
  }

  /** True when the active config is good enough to attempt delivery. */
  async isAvailable(): Promise<boolean> {
    return (await this.getTransporter()) !== null;
  }

  /**
   * Reload the transport from current settings -- invoked by the
   * admin save endpoint so the very next send uses the new config.
   * Closes the old pool first so existing TCP connections don't
   * stick around with stale auth.
   */
  async reload(): Promise<void> {
    const old = this.transporter;
    this.transporter = null;
    this.settings.invalidateSmtpCache();
    try {
      old?.close();
    } catch {
      // Closing a partially-initialised pool can throw on some
      // nodemailer versions; ignore -- we're throwing it away
      // anyway.
    }
    // Eagerly rebuild so the next send is hot.
    await this.getTransporter();
  }

  /**
   * Deliver a single message. Throws on transport-level failure so
   * the worker can record the error and decide whether to retry.
   * Caller is responsible for not calling when isAvailable() is
   * false (the worker guards on this).
   */
  async send(opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    const t = await this.getTransporter();
    if (!t) {
      throw new Error('SMTP transport not configured');
    }
    await t.sendMail({
      from: this.cachedFrom,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  }

  /**
   * One-shot test send that bypasses the queue and pool entirely.
   * Used by /admin/notifications/smtp/test so admins can verify
   * config without enqueueing a real notification. Builds a fresh
   * single-use transport from the supplied (possibly unsaved)
   * config so the admin can hit Send test before clicking Save.
   */
  async sendTest(
    cfg: SmtpConfig,
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    if (!cfg.host) throw new Error('SMTP host is empty');
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user
        ? { auth: { user: cfg.user, pass: cfg.password ?? '' } }
        : {}),
    });
    try {
      await transport.sendMail({
        from: formatFrom(cfg),
        to,
        subject,
        text,
        html,
      });
    } finally {
      try {
        transport.close();
      } catch {
        // Same defensive close as in reload()
      }
    }
  }
}

function formatFrom(cfg: SmtpConfig): string {
  if (!cfg.fromAddress) return 'GratisGIS <noreply@gratisgis.local>';
  if (cfg.fromDisplayName) {
    return `${cfg.fromDisplayName} <${cfg.fromAddress}>`;
  }
  return cfg.fromAddress;
}
