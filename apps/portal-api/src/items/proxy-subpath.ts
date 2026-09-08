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
 * becomes a `/` in an http(s) URL and is refused for the same reason.
 */
export function isUnsafeProxySegment(segment: string): boolean {
  if (segment === '') return true;
  const lowered = segment.toLowerCase();
  if (lowered.includes('\\') || lowered.includes('%5c')) return true;
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
  // Strip a trailing slash on the base so we can join with subPath
  // cleanly without a double slash.
  const trimmed = base.replace(/\/$/, '');
  let joined: string;
  if (subPath.length === 0) {
    joined = trimmed;
  } else if (subPath.startsWith('?')) {
    // subPath is just a query string (e.g. probing the service root
    // with ?f=json from the detail page's Probe button). Don't insert
    // a slash before the '?' or we'd produce an empty path segment
    // that some servers reject.
    joined = `${trimmed}${subPath}`;
  } else {
    joined = `${trimmed}/${subPath}`;
  }

  let composed: URL;
  let baseUrl: URL;
  try {
    composed = new URL(joined);
    baseUrl = new URL(trimmed);
  } catch {
    throw new ProxyPathError('Proxy target is not a valid URL');
  }
  if (!isAtOrBelow(composed.pathname, baseUrl.pathname)) {
    throw new ProxyPathError('Proxy sub-path escapes the item URL');
  }

  if (credential?.kind === 'arcgis_token') {
    composed.searchParams.set('token', credential.token);
    return composed.toString();
  }
  return joined;
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
