import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Thin nodemailer wrapper: build the SMTP transport from env once,
 * expose a single `send()` the worker calls per queued
 * notification. Connection pooling is on by default; nodemailer
 * keeps a small pool of authenticated SMTP connections open and
 * reuses them across messages.
 *
 * Configuration is env-only for Phase 1. Phase 2 may move SMTP
 * creds into an encrypted DB table (mirroring ItemCredential) so
 * org admins can change SMTP settings without a redeploy. Today
 * the env wins so a typo can't lock the queue.
 *
 * Required env (NOTIFICATIONS_ENABLED must be 'true' for any of
 * this to matter):
 *   SMTP_HOST   - smtp.example.org
 *   SMTP_PORT   - 587 (default)
 *   SMTP_USER   - mailbox username (optional for unauthed relays)
 *   SMTP_PASS   - mailbox password (optional, paired with SMTP_USER)
 *   SMTP_FROM   - "GratisGIS <noreply@example.org>"
 *   SMTP_SECURE - 'true' to force TLS-on-connect (defaults: true on
 *                 port 465, false elsewhere). Most modern relays
 *                 use STARTTLS on 587 which nodemailer negotiates
 *                 automatically when SMTP_SECURE=false.
 */
@Injectable()
export class EmailTransport {
  private readonly log = new Logger(EmailTransport.name);
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private readonly enabled: boolean;

  constructor(private readonly cfg: ConfigService) {
    this.enabled =
      (this.cfg.get<string>('NOTIFICATIONS_ENABLED') ?? '').toLowerCase() ===
      'true';
    this.fromAddress =
      this.cfg.get<string>('SMTP_FROM') ?? 'GratisGIS <noreply@gratisgis.local>';
  }

  /**
   * Lazily build the transporter on first send. Defers any "is the
   * SMTP host reachable" failures to the moment the worker actually
   * has something to deliver, rather than the api boot where a
   * misconfigured SMTP would crash startup for everyone.
   */
  private getTransporter(): Transporter | null {
    if (!this.enabled) return null;
    if (this.transporter) return this.transporter;
    const host = this.cfg.get<string>('SMTP_HOST');
    if (!host) {
      this.log.warn(
        'NOTIFICATIONS_ENABLED=true but SMTP_HOST is unset; email delivery disabled.',
      );
      return null;
    }
    const portRaw = this.cfg.get<string>('SMTP_PORT') ?? '587';
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      this.log.warn(`SMTP_PORT=${portRaw} is invalid; email delivery disabled.`);
      return null;
    }
    const secureRaw = (this.cfg.get<string>('SMTP_SECURE') ?? '').toLowerCase();
    // Default to true on port 465 (SMTPS), false elsewhere -- the
    // canonical pairing nodemailer's docs recommend.
    const secure = secureRaw === 'true' || (secureRaw === '' && port === 465);
    const user = this.cfg.get<string>('SMTP_USER');
    const pass = this.cfg.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user ? { auth: { user, pass: pass ?? '' } } : {}),
      pool: true,
    });
    this.log.log(`SMTP transport configured: host=${host} port=${port} secure=${secure}`);
    return this.transporter;
  }

  /** True when env is configured well enough to attempt delivery. */
  isAvailable(): boolean {
    return this.getTransporter() !== null;
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
    const t = this.getTransporter();
    if (!t) {
      throw new Error('SMTP transport not configured');
    }
    await t.sendMail({
      from: this.fromAddress,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  }
}
