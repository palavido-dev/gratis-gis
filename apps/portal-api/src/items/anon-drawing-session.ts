// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Anonymous drawing-author session (#154 / R3-anonymous-markup).
 *
 * When a public map has `allowAnonymousDrawings: true`, logged-out
 * visitors can create and edit their own markup sets. Identity is a
 * stable per-browser cookie: the same token lets the visitor edit
 * sets they authored on return visits; other visitors cannot.
 *
 * Cookie is intentionally readable by the browser so the Markup
 * panel can match `authorDisplay` client-side. The server still
 * stores the raw token on each anon set and checks it on write
 * (display matching alone would let a forged display claim another
 * reviewer's set). No captcha in v1; rate limits on the write
 * routes are the abuse bound.
 */
export const ANON_DRAWING_COOKIE = 'gg_anon_drawing';

/** Max age: 365 days. Markup reviews can span weeks. */
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnonDrawingSession = {
  token: string;
  display: string;
};

/**
 * Derive the stable display label from a session token. Kept as a
 * pure function so the portal-web Markup panel can recompute the
 * same label from the cookie without a round-trip.
 */
export function anonDrawingDisplayFor(token: string): string {
  return `Anonymous ${token.slice(0, 6)}`;
}

/**
 * Read an existing anon drawing session from the request cookie, or
 * mint a new one and attach `Set-Cookie` on the response. Call only
 * from @Public write handlers that may run without a JWT.
 */
export function readOrMintAnonDrawingSession(
  req: Request,
  res: Response,
): AnonDrawingSession {
  const existing = readAnonDrawingSession(req);
  if (existing) return existing;

  const token = randomUUID();
  const display = anonDrawingDisplayFor(token);
  setAnonDrawingCookie(res, token);
  return { token, display };
}

/** Read only; returns null when the cookie is missing or malformed. */
export function readAnonDrawingSession(
  req: Request,
): AnonDrawingSession | null {
  const raw = readCookie(req, ANON_DRAWING_COOKIE);
  if (!raw || !UUID_RE.test(raw)) return null;
  return { token: raw, display: anonDrawingDisplayFor(raw) };
}

function setAnonDrawingCookie(res: Response, token: string): void {
  const secure =
    process.env.NODE_ENV === 'production' ||
    process.env.COOKIE_SECURE === '1';
  // Not HttpOnly: the Markup panel reads the token to decide which
  // sets the visitor authored. SameSite=Lax + Path=/ keeps it from
  // riding cross-site POSTs while still covering every BFF path.
  const parts = [
    `${ANON_DRAWING_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SEC}`,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
