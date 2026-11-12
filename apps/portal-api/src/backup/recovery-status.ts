// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises';

/**
 * Host recovery status, written by infra/recovery/*.sh. The file is
 * operator-mounted and opt-in (GRATIS_RECOVERY_STATUS_FILE). It must
 * not contain secrets; the scripts write outcome and phase only.
 */
export interface RecoveryStatus {
  outcome: 'succeeded' | 'failed';
  phase: string;
  kind: string;
  portalDownload: boolean;
  offsiteVerified: boolean;
  immutable: boolean;
  detail: string;
}

const PHASE = /^[a-z0-9-]{1,40}$/;

export function parseRecoveryStatus(raw: string): RecoveryStatus | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const row = doc as Record<string, unknown>;
  if (row.outcome !== 'succeeded' && row.outcome !== 'failed') return null;
  if (typeof row.phase !== 'string' || !PHASE.test(row.phase)) return null;
  if (typeof row.detail !== 'string' || row.detail.length > 200) return null;
  return {
    outcome: row.outcome,
    phase: row.phase,
    kind: typeof row.kind === 'string' ? row.kind.slice(0, 40) : '',
    portalDownload: row.portalDownload === true,
    offsiteVerified: row.offsiteVerified === true,
    immutable: row.immutable === true,
    detail: row.detail,
  };
}

/** English sentence returned by the API. The web UI does not add a
 *  catalog key for it, so a new locale string cannot drift. */
export function recoveryBanner(status: RecoveryStatus | null): string | null {
  if (!status || status.outcome !== 'failed') return null;
  return 'The last host recovery did not finish. Check the recovery status before trusting this portal.';
}

export async function readRecoveryStatus(
  file: string | undefined,
): Promise<RecoveryStatus | null> {
  if (!file) return null;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    // No recovery has run yet: that is no status, not a failure.
    // Reporting it as failed mailed "host recovery failed" on the
    // first visit to the backup page.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return {
      outcome: 'failed',
      phase: 'status-file',
      kind: 'restore',
      portalDownload: false,
      offsiteVerified: false,
      immutable: false,
      detail: 'The recovery status file could not be read.',
    };
  }
  return parseRecoveryStatus(text);
}

export interface MailSink {
  send(opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void>;
}

/**
 * One failure notice through the existing mail transport. The body is
 * the status phase only. Callers pass the recipient; this function
 * does not read SMTP settings and does not log the message.
 */
/** One mail per failed phase. A later health poll does not send again.
 *  An empty recipient sends nothing. Success sends nothing. */
export function shouldAnnounceRecovery(
  seen: Set<string>,
  status: RecoveryStatus | null,
  to: string | undefined,
): boolean {
  if (!status || status.outcome !== 'failed') return false;
  if (!to) return false;
  const key = `${status.outcome}:${status.phase}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export async function announceRecoveryFailure(
  mail: MailSink,
  to: string,
  status: RecoveryStatus,
): Promise<void> {
  if (status.outcome !== 'failed') return;
  if (!to || to.length > 200) return;
  const text = `Host recovery failed during ${status.phase}. ${recoveryBanner(status)}`;
  await mail.send({
    to,
    subject: 'GratisGIS host recovery failed',
    text,
    html: `<p>${text}</p>`,
  });
}
