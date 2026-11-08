// SPDX-License-Identifier: AGPL-3.0-or-later

/** Existing installs keep a 365-day portal cookie. */
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const MIN_SECONDS = 15 * 60;
const MAX_SECONDS = DEFAULT_SESSION_MAX_AGE_SECONDS;

/**
 * Portal cookie lifetime. Unset or invalid values keep the default.
 * This does not revoke a Keycloak session that is already issued.
 */
export function sessionMaxAgeSeconds(
  raw = process.env.GRATIS_SESSION_MAX_AGE_SECONDS,
): number {
  return boundedOr(raw, DEFAULT_SESSION_MAX_AGE_SECONDS);
}

/**
 * Idle window for the portal cookie. Unset means no idle check, which
 * is the existing behavior. A value does not call Keycloak's revoke
 * endpoint and does not expire cookies that are not presented again.
 */
export function sessionIdleSeconds(
  raw = process.env.GRATIS_SESSION_IDLE_SECONDS,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = boundedOr(raw, null);
  return parsed;
}

function boundedOr(raw: string | undefined, fallback: number): number;
function boundedOr(raw: string | undefined, fallback: null): number | null;
function boundedOr(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < MIN_SECONDS || n > MAX_SECONDS) return fallback;
  return n;
}
