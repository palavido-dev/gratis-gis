// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side mirror of portal-api's anon drawing cookie session
 * (#154 / R3-anonymous-markup). The API mints `gg_anon_drawing` on
 * the first anonymous markup write; the Markup panel reads it to
 * decide which sets the visitor authored (matching authorDisplay).
 *
 * Display derivation MUST stay in lockstep with
 * `anonDrawingDisplayFor` in portal-api's anon-drawing-session.ts.
 */

export const ANON_DRAWING_COOKIE = 'gg_anon_drawing';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function anonDrawingDisplayFor(token: string): string {
  return `Anonymous ${token.slice(0, 6)}`;
}

/**
 * Read the anon drawing cookie from `document.cookie`. Returns the
 * derived display label, or null when missing / malformed / SSR.
 */
export function readAnonDrawingDisplay(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${ANON_DRAWING_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(ANON_DRAWING_COOKIE.length + 1);
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    token = raw;
  }
  if (!UUID_RE.test(token)) return null;
  return anonDrawingDisplayFor(token);
}
