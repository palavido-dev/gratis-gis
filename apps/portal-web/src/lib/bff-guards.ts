// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Request guards for the portal-api BFF (app/api/portal/[...path]).
 * Pure functions so they can be tested without a Next server.
 */

// Matching control characters is the point: URL parsing strips them.
// eslint-disable-next-line no-control-regex
const URL_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * True when a path segment must not reach the upstream URL.
 *
 * Next hands catch-all segments over percent-decoded, and the joined
 * suffix is parsed again by WHATWG URL when the upstream fetch is
 * built. Any segment that URL parsing would reinterpret lets a
 * request that matched one allowlist regex land on a different /api
 * path:
 * - empty (from `//`), `.` or `..`, including the `%2e` spellings
 *   that a double-encoded request leaves behind;
 * - a backslash, which WHATWG URL treats as `/` in http(s) URLs, so
 *   `x\..\..\admin` walks out of `/api/public/`;
 * - `?` or `#`, which would end the path early;
 * - an ASCII tab, newline or other control character, which URL
 *   parsing strips, so `.\n.` would become `..`.
 * No legitimate client sends any of these.
 */
export function isUnsafePathSegment(segment: string): boolean {
  if (segment === '') return true;
  if (/[\\?#]/.test(segment) || URL_CONTROL.test(segment)) return true;
  const decodedDots = segment.toLowerCase().replace(/%2e/g, '.');
  return decodedDots === '.' || decodedDots === '..';
}

/** True when any segment of the joined suffix is unsafe. */
export function hasUnsafePathSegment(suffix: string): boolean {
  return suffix.split('/').some(isUnsafePathSegment);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Cross-site request check for cookie-authenticated mutations.
 *
 * The BFF turns the session cookie into a bearer token, so a browser
 * request from another origin that carries the cookie acts as the
 * user. `SameSite=Lax` stops cross-site POSTs but not same-site ones,
 * and other apps on the same NAS IP (any port) or sibling subdomains
 * on a VPS are same-site. portal-api also parses urlencoded bodies,
 * so a plain HTML form needs no preflight.
 *
 * Returns true when a state-changing request should be refused:
 * - `Sec-Fetch-Site` is present and is not `same-origin` or `none`;
 * - otherwise, `Origin` is present and its host is not this host.
 * A request with neither header is not from a browser that would
 * attach the cookie on someone else's behalf, so it passes.
 */
export function isCrossOriginMutation(
  method: string,
  headers: HeaderSource,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headers.get('origin')?.trim();
  if (!origin) return false;
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase();
  if (!host) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // `Origin: null` (sandboxed frames, file:) and garbage.
    return true;
  }
  return originHost !== host;
}

/**
 * Security headers for a BFF response, from the upstream response.
 *
 * portal-api sets protective headers per response: the item and
 * public proxies send a sandbox CSP and nosniff, thumbnail.svg sends
 * a script-free CSP. Those pass through unchanged. When the upstream
 * sends no CSP the page policy applies, as it does to every other
 * portal path (next.config skips /api/portal/ so this one wins).
 */
export function securityResponseHeaders(
  upstream: HeaderSource,
  pageCsp: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  out.push([
    'content-security-policy',
    upstream.get('content-security-policy') ?? pageCsp,
  ]);
  const nosniff = upstream.get('x-content-type-options');
  if (nosniff) out.push(['x-content-type-options', nosniff]);
  return out;
}

/** Header the print preview page sends its per-job read credential in. */
export const PRINT_READ_HEADER = 'x-print-read';

/**
 * The bearer to forward for a print preview's layer read, or null.
 *
 * The server-side print opens the preview page in a headless browser
 * with no session. portal-api gives that page a short-lived read
 * credential for the job, and the page sends it in a header (never
 * the URL, so it stays out of access logs and Referer). This lets it
 * through only on the GET routes the print reads layer data from;
 * portal-api checks it again, along with the item ids and the user's
 * access. A request with a real session never uses it.
 */
export function printReadBearer(
  method: string,
  suffix: string,
  headerValue: string | null,
): string | null {
  if (method !== 'GET' || !headerValue) return null;
  if (
    headerValue.length > 16_384 ||
    !/^ggprint\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(headerValue)
  ) {
    return null;
  }
  const readRoute =
    /^items\/[^/]+\/geojson$/.test(suffix) ||
    /^items\/[^/]+\/layers\/[^/]+\/geojson$/.test(suffix) ||
    /^items\/[^/]+\/proxy\/\d+\/query$/.test(suffix);
  return readRoute ? headerValue : null;
}
