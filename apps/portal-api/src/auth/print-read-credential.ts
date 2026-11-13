// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure pieces of the print read credential: the format, signing and
 * checking. The service and the guard decide who may use it and where.
 *
 * Why it exists: the server-side print opens the preview page in a
 * headless browser that has no user session. Without a credential,
 * every layer fetch from that page reads as anonymous, so any layer
 * that is not public is missing from the PDF. portal-api mints one of
 * these per print job for the user who asked for the print. It names
 * that user and the item ids the print draws, and nothing else.
 *
 * It is not a session. It is accepted only on a short list of GET
 * routes that read layer data (see PrintReadable), only for the item
 * ids it carries, and the request still runs as that user, rebuilt
 * from the database on every request, so it never reads more than the
 * user can read at that moment.
 */

/** Marks the scheme, so the guard can tell it from a JWT or an API key. */
export const PRINT_READ_PREFIX = 'ggprint.';

/**
 * How long a credential lives. A render holds the page for at most
 * 45 s (30 s to load, 15 s for the map to settle), so one minute
 * covers every layer fetch of one job and little more.
 */
export const PRINT_READ_TTL_MS = 60_000;

/** Most item ids one credential carries. Keeps the header small. */
export const PRINT_READ_MAX_ITEMS = 200;

/** Longest credential the checker reads, so a huge header costs nothing. */
const MAX_LENGTH = 16_384;

/** HKDF label for the signing key. A purpose of its own: no shared key. */
export const PRINT_READ_KEY_LABEL = 'print-read-credential-v1';

export interface PrintReadClaims {
  /** User the print runs as. */
  uid: string;
  /** Item ids the print may read. */
  ids: string[];
  /** Expiry, ms since epoch. */
  exp: number;
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`print-read.v1.${body}`).digest();
}

export function signPrintReadCredential(
  claims: PrintReadClaims,
  key: Buffer,
): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${PRINT_READ_PREFIX}${body}.${mac(key, body).toString('base64url')}`;
}

/** Cheap shape check, done before any crypto. */
export function looksLikePrintReadCredential(value: string): boolean {
  return (
    value.length <= MAX_LENGTH &&
    /^ggprint\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Claims from a credential, or null when it is malformed, carries a
 * bad signature, or has expired.
 */
export function verifyPrintReadCredential(
  value: unknown,
  key: Buffer,
  now = Date.now(),
): PrintReadClaims | null {
  if (typeof value !== 'string' || !looksLikePrintReadCredential(value)) {
    return null;
  }
  const rest = value.slice(PRINT_READ_PREFIX.length);
  const dot = rest.indexOf('.');
  const body = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), 'base64url');
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const c = parsed as Partial<PrintReadClaims> | null;
  if (
    !c ||
    typeof c.uid !== 'string' ||
    typeof c.exp !== 'number' ||
    !Array.isArray(c.ids) ||
    !c.ids.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  if (c.exp < now) return null;
  return { uid: c.uid, ids: c.ids, exp: c.exp };
}
