// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Refuse portal API URLs whose path was built from values that walk
 * out of the route they were meant for.
 *
 * Many pages build `/api/portal/items/${id}/...` from ids stored in
 * saved item JSON (maps, apps, editors). A saved id such as
 * `../scripts/<id>/run?x=` makes the browser normalize the dots away
 * before the request leaves, so the BFF cannot see them, and the
 * viewer's own session calls a different endpoint. Checking the raw
 * string before it is sent is the one place that sees what the code
 * built. The sinks also check ids themselves (isUuid); this is the
 * net under all of them, including code written later.
 *
 * Only same-origin `/api/` URLs are checked. The path is the part
 * before the first `?` or `#`; a dot segment, an empty segment, a
 * backslash or a control character in it means the URL was assembled
 * from something that was not an id.
 */

import { isUnsafePathSegment } from './bff-guards';

const API_PREFIX = '/api/';

function apiPathOf(raw: string, origin: string | null): string | null {
  let rest = raw;
  if (origin && rest.startsWith(origin)) rest = rest.slice(origin.length);
  if (!rest.startsWith(API_PREFIX)) return null;
  const cut = rest.search(/[?#]/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** True when `raw` is a same-origin API URL with an unsafe path. */
export function isUnsafeApiUrl(raw: string, origin: string | null = null): boolean {
  const path = apiPathOf(raw, origin);
  if (path === null) return false;
  // Leading '/' gives one empty first segment; a trailing '/' is fine.
  const segs = path.split('/').slice(1);
  if (segs.length > 0 && segs[segs.length - 1] === '') segs.pop();
  return segs.some(isUnsafePathSegment);
}

/** Throws when `raw` is an unsafe API URL. */
export function assertSafeApiUrl(raw: string, origin: string | null = null): void {
  if (isUnsafeApiUrl(raw, origin)) {
    throw new TypeError(`Refused an API request with an unsafe path: ${JSON.stringify(raw.slice(0, 200))}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string. */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

let installed = false;

/**
 * Wrap window.fetch once so every same-origin API call is checked.
 * Safe to call more than once and on the server (no-op there).
 */
export function installApiPathGuard(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  const origin = window.location.origin;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // A URL object or a Request has already been normalized; only the
    // string form still shows what the caller built.
    if (typeof input === 'string') assertSafeApiUrl(input, origin);
    return original(input, init);
  };
}
