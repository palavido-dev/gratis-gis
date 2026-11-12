// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CredentialPayload } from './credential.service.js';

/**
 * Sub-path handling shared by the authenticated upstream proxy
 * (`ItemProxyController`) and its anonymous twin
 * (`PublicProxyController`).
 *
 * Both take whatever follows `/proxy` on the request URL and append
 * it to the item's stored `data.url`, then fetch the result with the
 * item's stored credential injected. Express hands the sub-path over
 * exactly as the client sent it, dots and all, so before this helper
 * existed `/proxy/../../admin` composed to
 * `https://upstream/arcgis/rest/services/../../admin`, which the URL
 * parser inside fetch collapses to `https://upstream/admin`: any GET
 * path on the upstream host, with the credential attached, reachable
 * by anyone who could read the item. The stored URL is meant to be a
 * boundary, not a starting point.
 *
 * Two checks, both here so the controllers cannot drift apart:
 *
 *  - Every path segment is rejected when it is empty or a dot
 *    segment, in raw or percent-encoded spelling, the same test the
 *    BFF applies in `apps/portal-web/src/app/api/portal/[...path]`.
 *    Backslashes are refused too, because WHATWG URL parsing treats
 *    `\` as `/` on http(s) URLs, so `..\` is a traversal the split on
 *    `/` would not see.
 *  - After composing, the parsed upstream pathname must still sit at
 *    or below the stored URL's pathname. This is the check that
 *    matters; the segment test only exists to give a clear 400.
 *
 * Kept free of Nest so it can be unit tested as a pure function. The
 * controllers map `ProxyPathError` to a 400.
 */
export class ProxyPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyPathError';
  }
}

/**
 * True when a path segment would collapse during URL normalisation:
 * empty (from `//` or a trailing slash), a single dot, or a double
 * dot. WHATWG URL also treats `%2e`, `%2e%2e`, `.%2e` and `%2e.` as
 * dot segments, so those count too. A backslash, raw or as `%5c`,
 * becomes a `/` in an http(s) URL and is refused for the same reason,
 * and so is an encoded slash (`%2f`).
 */
export function isUnsafeProxySegment(segment: string): boolean {
  if (segment === '') return true;
  const lowered = segment.toLowerCase();
  if (lowered.includes('\\') || lowered.includes('%5c')) return true;
  // An encoded slash stays encoded through WHATWG parsing, so the
  // pathname check below passes, but a front end that decodes before
  // normalising (IIS in front of ArcGIS Server) would walk up from
  // the stored path. Refuse it with the backslash.
  if (lowered.includes('%2f')) return true;
  const decodedDots = lowered.replace(/%2e/g, '.');
  return decodedDots === '.' || decodedDots === '..';
}

/**
 * Pull everything after `/proxy/` from the request URL. Returns ''
 * when the request hits exactly `/proxy` with no trailing path. The
 * query string, if any, stays attached so the caller can forward it.
 *
 * Throws `ProxyPathError` when any path segment fails
 * `isUnsafeProxySegment`. The query string is not inspected: it
 * cannot change which path the upstream serves.
 */
export function extractSubPath(url: string): string {
  const match = /\/proxy(?=\/|\?|$)/.exec(url);
  if (!match) return '';
  let after = url.slice(match.index + '/proxy'.length);
  if (after.startsWith('/')) after = after.slice(1);
  const queryAt = after.indexOf('?');
  const path = queryAt >= 0 ? after.slice(0, queryAt) : after;
  if (path.length > 0 && path.split('/').some(isUnsafeProxySegment)) {
    throw new ProxyPathError('Proxy sub-path contains a disallowed segment');
  }
  return after;
}

/**
 * Compose the final upstream URL: `<item.data.url>` + '/' + `<subPath>`,
 * preserving query params on both sides. `arcgis_token` credentials
 * are appended as a query param here so they end up in the URL the
 * upstream sees. Null credential = no token to inject (item does not
 * require auth).
 *
 * Throws `ProxyPathError` when the composed URL does not parse or
 * when its pathname escapes the stored URL's pathname.
 */
export function composeUpstreamUrl(
  base: string,
  subPath: string,
  credential: CredentialPayload | null,
): string {
  // Parse the stored URL once and put the sub-path into its pathname
  // and the sub-path's query after its own query. Joining strings put
  // the sub-path inside the query when the stored URL had one
  // (`.../MapServer?a=b` + `/0/query` became `?a=b/0/query`).
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new ProxyPathError('Proxy target is not a valid URL');
  }
  const queryAt = subPath.indexOf('?');
  const subPathPart = queryAt >= 0 ? subPath.slice(0, queryAt) : subPath;
  const subQuery = queryAt >= 0 ? subPath.slice(queryAt + 1) : '';

  const composed = new URL(baseUrl.toString());
  // Strip a trailing slash on the base so the join has no `//`.
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  if (subPathPart.length > 0) {
    composed.pathname = `${basePath}/${subPathPart}`;
  } else if (basePath !== baseUrl.pathname && basePath.length > 0) {
    composed.pathname = basePath;
  }
  if (subQuery.length > 0) {
    // Raw concatenation keeps the client's own encoding of both.
    const baseQuery = baseUrl.search.replace(/^\?/, '');
    composed.search = baseQuery ? `${baseQuery}&${subQuery}` : subQuery;
  }
  if (!isAtOrBelow(composed.pathname, basePath || '/')) {
    throw new ProxyPathError('Proxy sub-path escapes the item URL');
  }

  if (credential?.kind === 'arcgis_token') {
    composed.searchParams.set('token', credential.token);
  }
  return composed.toString();
}

/**
 * `child` equals `parent` or lives under it as a whole segment.
 * Written with an explicit separator rather than a bare `startsWith`
 * so `/services/X/MapServerEvil` is not "under" `/services/X/MapServer`.
 */
function isAtOrBelow(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}
