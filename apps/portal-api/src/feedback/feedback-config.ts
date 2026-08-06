// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-portal feedback is opt-in. A self-hosted GratisGIS should not
 * grow a public, unauthenticated write endpoint because someone
 * upgraded; the operator turns it on deliberately, after deciding
 * where the submissions should land.
 *
 * The demo portal sets PORTAL_FEEDBACK_ENABLED=1.
 */
export function isFeedbackEnabled(): boolean {
  return isTruthy(process.env.PORTAL_FEEDBACK_ENABLED);
}

function isTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Where the notification email goes, or null when the operator has
 * not named an inbox.
 *
 * This deliberately no longer falls back to the upstream maintainer's
 * personal address. That fallback made sense when email was the only
 * record and a misconfigured portal would otherwise swallow feedback
 * silently. Now that submissions are stored in the portal's own
 * database, the failure mode it protected against is gone, and the
 * behaviour it created is worse: someone else's users' words, and
 * their IP addresses, mailed to a third party who never asked for
 * them and cannot action them.
 *
 * With no recipient the submission still persists and still appears
 * in the admin triage view. Only the email notification is skipped.
 */
export function resolveFeedbackRecipient(): string | null {
  const explicit = process.env.FEEDBACK_RECIPIENT_EMAIL?.trim();
  if (explicit) return explicit;
  // ACME_EMAIL is a real inbox the operator already had to supply to
  // obtain TLS certificates, so it is a reasonable second choice.
  const acme = process.env.ACME_EMAIL?.trim();
  if (acme && acme !== 'you@example.com') return acme;
  return null;
}

/** Largest screenshot we accept. Big enough for a full-page capture
 *  on a 4K display, small enough that a public endpoint cannot be
 *  turned into free file hosting. */
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** Rate-limit budgets, counted over persisted rows so both API
 *  replicas share one view and a deploy does not reset the window. */
export const SHORT_WINDOW_MS = 5 * 60 * 1000;
export const SHORT_LIMIT = 3;
export const LONG_WINDOW_MS = 60 * 60 * 1000;
export const LONG_LIMIT = 20;
