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
 *
 * A value that is set but out of range is clamped to 15 minutes to
 * 365 days, and one that is not a whole number of seconds uses the
 * 15 minute minimum. Both log a warning. Treating them as unset, as
 * before, silently turned off the idle lock the operator asked for.
 */
export function sessionIdleSeconds(
  raw = process.env.GRATIS_SESSION_IDLE_SECONDS,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    warnIdle(`"${value}" is not a whole number of seconds; using ${MIN_SECONDS}.`);
    return MIN_SECONDS;
  }
  const n = Number(value);
  if (n < MIN_SECONDS) {
    warnIdle(`${n} is below the ${MIN_SECONDS} second minimum; using ${MIN_SECONDS}.`);
    return MIN_SECONDS;
  }
  if (!Number.isSafeInteger(n) || n > MAX_SECONDS) {
    warnIdle(`${value} is above the ${MAX_SECONDS} second maximum; using ${MAX_SECONDS}.`);
    return MAX_SECONDS;
  }
  return n;
}

const warnedIdle = new Set<string>();
function warnIdle(message: string): void {
  // Read on every request; say it once per distinct problem.
  if (warnedIdle.has(message)) return;
  warnedIdle.add(message);
  console.warn(`GRATIS_SESSION_IDLE_SECONDS: ${message}`);
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
