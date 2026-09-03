// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-request CORS policy for portal-api.
 *
 * Two audiences hit this process from a browser, and they want
 * opposite things:
 *
 *  - The portal's own UI never makes a cross-origin call here. In prod
 *    Caddy serves portal-api under the web origin (`/api/*`), and in
 *    dev every browser call goes through the BFF at `/api/portal/*`
 *    on the web port. So nothing first-party needs CORS at all, and a
 *    blanket `cors: true` (reflect any origin) was pure exposure:
 *    every authenticated endpoint answered preflights for any site on
 *    the internet.
 *  - The open-data surface under `/api/public/*` (OGC API Features,
 *    Tiles, Records, STAC, public GeoJSON) exists precisely so that
 *    other websites can load it into their own Leaflet or OpenLayers
 *    page. Those need `*`, read methods only.
 *
 * Everything else answers only origins listed in
 * `CORS_ALLOWED_ORIGINS` (comma separated, exact origin match). The
 * default is the empty list, which emits no CORS headers, so an
 * embedded-portal deployment opts in explicitly. Bearer tokens are the
 * only credential portal-api accepts, so `credentials` stays off and
 * cookies never ride a cross-origin call.
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Route bases any origin may read: the base itself or anything below
 * it, matched on whole path segments so `/healthz` or `/api/publicity`
 * do not ride along.
 */
const PUBLIC_BASES = ['/api/public', '/health'] as const;

export const PUBLIC_CORS: CorsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
};

export function isPublicCorsPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return PUBLIC_BASES.some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * Parse the env allowlist. Trims, drops blanks, and normalises each
 * entry to a bare origin so a trailing slash or path in the value
 * (`https://portal.example.org/`) still matches what a browser sends
 * in the Origin header. An entry that does not parse as a URL is
 * dropped rather than kept as a never-matching string, and reported
 * so a typo does not read as "CORS is broken".
 */
export function parseAllowedOrigins(
  raw: string | undefined,
  onInvalid: (entry: string) => void = () => {},
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      onInvalid(trimmed);
      continue;
    }
    if (origin === 'null') {
      onInvalid(trimmed);
      continue;
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * Build the per-request options delegate `enableCors` accepts. The
 * `cors` package reflects the request Origin only when it is in the
 * `origin` array; an empty array means it never matches, so no
 * `Access-Control-Allow-*` header is written and the browser refuses
 * the cross-origin call at preflight.
 */
export function corsOptionsFor(
  req: { url?: string },
  allowedOrigins: readonly string[],
): CorsOptions {
  if (isPublicCorsPath(req.url ?? '')) return PUBLIC_CORS;
  return { origin: [...allowedOrigins] };
}
