// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { EmailTransport } from '../notifications/email-transport.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  LONG_LIMIT,
  LONG_WINDOW_MS,
  SHORT_LIMIT,
  SHORT_WINDOW_MS,
  resolveFeedbackRecipient,
} from './feedback-config.js';
import { hashIp } from './ip-hash.js';

export interface FeedbackInput {
  /** Optional sender name. Free-form; not validated against any user table. */
  name?: string;
  /** Optional sender email so the maintainer can reply. */
  email?: string;
  /** Required body of the feedback. */
  message: string;
  /** Page the reporter was on when they opened the form. */
  pageUrl?: string;
  /** Portal version the reporter was running. */
  appVersion?: string;
  /** Browser user-agent string. */
  userAgent?: string;
  /** Viewport as "WxH", e.g. "1512x945". */
  viewport?: string;
  /** Set when a signed-in user submitted. */
  userId?: string;
  orgId?: string;
  /** Raw client IP, captured server-side. Hashed before storage. */
  ip: string;
  /** Optional screenshot bytes, already validated as a real image. */
  screenshot?: { body: Buffer; contentType: string };
}

/**
 * In-portal feedback intake (#146).
 *
 * The point is that a tester who does not have, and does not want, a
 * GitHub account can still report something. Originally this was
 * fire-and-forget email. It is now database-first, for one reason:
 * on a public demo the feedback IS the product signal, and email is
 * the least reliable link in the chain. A dropped SMTP connection, an
 * over-eager spam filter, or a misconfigured recipient all used to
 * destroy the only copy.
 *
 * Order of operations, and why:
 *
 *   1. Rate-limit against persisted rows, so both API replicas share
 *      one view of a source and a deploy does not reset the window.
 *   2. Store the screenshot, if any. Before the row, so a storage
 *      failure cannot orphan a row that references a missing object.
 *   3. Write the row. This is the durable record and the point of no
 *      return: once it succeeds the submission is safe.
 *   4. Email as a best-effort NOTIFICATION.
 *
 * Step 4 no longer throws. That is a deliberate change from the
 * email-only design, where a send failure had to surface so the user
 * knew to retry. Now a send failure means the maintainer's nudge was
 * lost, not the feedback, and reporting it as an error would invite a
 * duplicate submission of something already safely stored.
 */
@Injectable()
export class FeedbackService {
  private readonly log = new Logger(FeedbackService.name);

  constructor(
    private readonly mail: EmailTransport,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * True when this source has spent its budget. Counts rows rather
   * than in-process timestamps: the old in-memory limiter claimed
   * 3-per-5-minutes but delivered 6 across two replicas, and forgot
   * everything on every deploy.
   */
  async isRateLimited(ip: string, now: Date = new Date()): Promise<boolean> {
    const ipHash = hashIp(ip);
    const [shortCount, longCount] = await Promise.all([
      this.prisma.feedback.count({
        where: {
          ipHash,
          createdAt: { gte: new Date(now.getTime() - SHORT_WINDOW_MS) },
        },
      }),
      this.prisma.feedback.count({
        where: {
          ipHash,
          createdAt: { gte: new Date(now.getTime() - LONG_WINDOW_MS) },
        },
      }),
    ]);
    return shortCount >= SHORT_LIMIT || longCount >= LONG_LIMIT;
  }

  async submit(input: FeedbackInput): Promise<{ id: string }> {
    let screenshotKey: string | null = null;
    if (input.screenshot) {
      try {
        const { key } = await this.storage.uploadBuffer(
          'feedback-screenshot',
          input.screenshot.body,
          input.screenshot.contentType,
        );
        screenshotKey = key;
      } catch (err) {
        // An image we could not store must not cost us the words.
        // Losing the attachment is a degraded report; losing the
        // report is a lost bug.
        this.log.warn(
          `feedback screenshot upload failed, saving text only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const row = await this.prisma.feedback.create({
      data: {
        message: input.message,
        ...(input.name ? { name: input.name } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
        ...(input.appVersion ? { appVersion: input.appVersion } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        ...(input.viewport ? { viewport: input.viewport } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.orgId ? { orgId: input.orgId } : {}),
        ipHash: hashIp(input.ip),
        ...(screenshotKey ? { screenshotKey } : {}),
      },
      select: { id: true },
    });

    // PII-light: the body is in the database and the email, not in
    // the logs, which are shipped and retained differently.
    this.log.log(
      `feedback stored id=${row.id} from=${input.email ?? '(anonymous)'} ` +
        `page="${truncate(input.pageUrl ?? '', 80)}" len=${input.message.length}` +
        `${screenshotKey ? ' +screenshot' : ''}`,
    );

    await this.notify(input, row.id, screenshotKey !== null);
    return { id: row.id };
  }

  /**
   * Best-effort email notification. Every failure path here is
   * logged and swallowed: by this point the submission is already
   * durable, so nothing the operator does about mail can lose it.
   */
  private async notify(
    input: FeedbackInput,
    id: string,
    hasScreenshot: boolean,
  ): Promise<void> {
    const recipient = resolveFeedbackRecipient();
    if (!recipient) {
      this.log.warn(
        `feedback ${id} stored but not emailed: no FEEDBACK_RECIPIENT_EMAIL ` +
          'configured. Read it in the portal under Admin -> Feedback.',
      );
      return;
    }
    if (!(await this.mail.isAvailable())) {
      this.log.warn(
        `feedback ${id} stored but not emailed: SMTP is not configured. ` +
          'Read it in the portal under Admin -> Feedback.',
      );
      return;
    }
    try {
      const { text, html } = renderBody(input, id, hasScreenshot);
      await this.mail.send({
        to: recipient,
        subject: renderSubject(input),
        text,
        html,
      });
    } catch (err) {
      this.log.error(
        `feedback ${id} stored, but the notification email failed: ${
          err instanceof Error ? err.message : String(err)
        }. The submission is safe; read it under Admin -> Feedback.`,
      );
    }
  }
}

function renderSubject(input: FeedbackInput): string {
  const who = input.email ?? input.name ?? 'anonymous';
  return `[GratisGIS feedback] ${truncate(input.message, 60)} (from ${who})`;
}

function renderBody(
  input: FeedbackInput,
  id: string,
  hasScreenshot: boolean,
): { text: string; html: string } {
  const rows: Array<[string, string]> = [
    ['From', input.email ?? '(not provided)'],
    ['Name', input.name ?? '(not provided)'],
    ['Page', input.pageUrl ?? '(not provided)'],
    ['Version', input.appVersion ?? '(not provided)'],
    ['Browser', input.userAgent ?? '(not provided)'],
    ['Viewport', input.viewport ?? '(not provided)'],
    ['Signed in', input.userId ? 'yes' : 'no'],
    ['Screenshot', hasScreenshot ? 'yes (link below)' : 'none'],
  ];
  // The raw IP is deliberately absent: it is not stored (only a keyed
  // hash is) so echoing it into an inbox would recreate exactly the
  // record the hashing exists to avoid.
  // A real link, not a breadcrumb. The first version of this email
  // said "attached, see the portal" and "Admin -> Feedback", which
  // told the reader a screenshot existed without telling them how to
  // reach it. If the notification is worth sending it is worth making
  // actionable in one click.
  const triageUrl = `${portalBaseUrl()}/admin/feedback`;
  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    '----',
    '',
    input.message,
    '',
    '----',
    '',
    hasScreenshot
      ? `A screenshot is attached to this submission. View it here:`
      : `Open in the portal:`,
    triageUrl,
    `(submission id ${id})`,
  ].join('\n');
  const html =
    `<p>${rows
      .map(([k, v]) => `<strong>${escape(k)}:</strong> ${escape(v)}`)
      .join('<br>')}</p><hr>` +
    `<pre style="white-space: pre-wrap; font-family: -apple-system, system-ui, sans-serif;">${escape(
      input.message,
    )}</pre>` +
    `<hr><p><a href="${escape(triageUrl)}">${
      hasScreenshot
        ? 'View the screenshot and triage this feedback'
        : 'Open this feedback in the portal'
    }</a></p>` +
    `<p style="color:#666;font-size:12px">Submission id ${escape(id)}</p>`;
  return { text, html };
}

/**
 * Public origin of the portal, for links in outbound mail. Same env
 * var the notification templates use, so an operator configures the
 * portal's address once. Trailing slash trimmed so callers can append
 * a path without doubling it.
 */
function portalBaseUrl(): string {
  const raw = process.env.PORTAL_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
