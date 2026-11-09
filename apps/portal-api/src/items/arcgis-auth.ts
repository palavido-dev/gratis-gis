// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ArcGIS REST token exchange helpers (#76).
 *
 * ArcGIS Online and ArcGIS Enterprise do not honour HTTP Basic auth
 * on data endpoints. The user-facing credential is a username +
 * password, but every actual call has to carry an ArcGIS-issued
 * token via `?token=...` (or `Authorization: Bearer <token>` on
 * Enterprise 11+). The exchange happens at a token endpoint that
 * the service self-describes through its `/info` resource:
 *
 *   GET <rest-root>/info?f=json
 *   -> { authInfo: { tokenServicesUrl: '<token-endpoint>', ... } }
 *
 * We discover the token endpoint per service URL the first time
 * we exchange, then cache the resulting token by (item, username,
 * tokenUrl) until it expires. This module is intentionally
 * stateless beyond that cache: it never persists tokens and never
 * sees them on disk.
 *
 * Why this lives in items/: the credential storage already lives
 * here and the only callers (probe endpoint + per-item proxy) are
 * also in this module.
 */

interface CachedToken {
  token: string;
  expires: number;
  /** The password that minted the token, so a replaced password is
   *  never answered with the old one's token. Held in memory only,
   *  like the credential the caller already passed in. */
  password: string;
}

const TOKEN_CACHE = new Map<string, CachedToken>();

/**
 * Exchange a username + password for an ArcGIS token. Returns the
 * token string. Caches successful exchanges in-process so the
 * proxy doesn't pay a 200ms round-trip on every request. Cache
 * key intentionally combines all the inputs so a credential change
 * invalidates without manual eviction.
 *
 * The cache eviction grace period is 60 seconds: tokens with less
 * than 60s remaining are treated as expired so a slow downstream
 * call doesn't fail mid-flight.
 */
import { timingSafeEqual } from 'node:crypto';

import { safeFetch } from '../common/net-guards.js';

/**
 * Cache key for an exchanged token. The token is sent to `serviceUrl`,
 * so the key carries it: a token minted for one URL must not be reused
 * after the item's URL is changed, even when the new URL advertises the
 * same token endpoint. The password is not in the key; the entry
 * records it and `reusableToken` checks it, so a replaced password is
 * used on the next request.
 */
export function tokenCacheKey(
  args: { cacheKey: string; username: string; serviceUrl: string },
  tokenUrl: string,
): string {
  return [args.cacheKey, args.serviceUrl, args.username, tokenUrl].join('|');
}

/**
 * The cached token when it was minted with this password and has more
 * than 60 seconds left, else null. The password comparison runs in
 * constant time.
 */
export function reusableToken(
  entry: CachedToken | undefined,
  password: string,
  now: number = Date.now(),
): string | null {
  if (!entry || entry.expires - 60_000 <= now) return null;
  const a = Buffer.from(entry.password, 'utf8');
  const b = Buffer.from(password, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return entry.token;
}

export async function exchangeBasicForArcgisToken(args: {
  serviceUrl: string;
  username: string;
  password: string;
  /** Cache namespacing key. Pass the item id when calling from the
   *  proxy; for an ad-hoc probe (no item yet) pass the credential
   *  itself or a stable hash so different users on the same host
   *  don't collide. */
  cacheKey: string;
}): Promise<string> {
  const tokenUrl = await discoverTokenEndpoint(args.serviceUrl);
  if (!tokenUrl) {
    throw new Error(
      'This service does not advertise a token endpoint. Try the ArcGIS Token credential type and paste a token directly.',
    );
  }
  const compositeKey = tokenCacheKey(args, tokenUrl);
  const cached = reusableToken(TOKEN_CACHE.get(compositeKey), args.password);
  if (cached !== null) return cached;

  const body = new URLSearchParams({
    f: 'json',
    username: args.username,
    password: args.password,
    // 'referer' clients are required by AGO's username/password
    // path; the referer string just needs to be consistent between
    // generateToken and the actual data call. We send it on both.
    client: 'referer',
    referer: 'https://gratisgis.local',
    expiration: '60',
  });
  let res: Response;
  try {
    // tokenUrl is derived from the user-provided serviceUrl via the
    // /info?f=json discovery step; route through safeFetch so an
    // attacker can't redirect token exchange to an internal host.
    res = await safeFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(
      `Could not reach token endpoint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}`);
  }
  const data = (await res.json()) as {
    token?: string;
    expires?: number;
    error?: { message?: string; details?: unknown };
  };
  if (data.error) {
    const msg =
      typeof data.error.message === 'string'
        ? data.error.message
        : 'Token exchange failed';
    throw new Error(msg);
  }
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Token endpoint did not return a token.');
  }
  // ArcGIS reports `expires` as a millisecond epoch.
  const expires =
    typeof data.expires === 'number' ? data.expires : Date.now() + 60 * 60_000;
  TOKEN_CACHE.set(compositeKey, {
    token: data.token,
    expires,
    password: args.password,
  });
  return data.token;
}

/**
 * Discover the token endpoint for a service by walking up to its
 * REST root and reading /info. Falls back to AGO's well-known
 * endpoint when the service URL is hosted on *.arcgis.com.
 *
 * Returns null when the service does not appear to require a
 * token (e.g. a public service we should never have been called
 * for in the first place) -- callers should treat that as an
 * application error, not a network failure.
 */
async function discoverTokenEndpoint(
  serviceUrl: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    return null;
  }

  // Try the REST-root /info path first. Per ArcGIS REST convention,
  // /info sits at the same level as /services so we slice the path
  // up to (and including) "rest".
  const segs = parsed.pathname.split('/').filter(Boolean);
  const restIdx = segs.indexOf('rest');
  if (restIdx >= 0) {
    const restRoot = segs.slice(0, restIdx + 1).join('/');
    const infoUrl = `${parsed.origin}/${restRoot}/info?f=json`;
    try {
      // infoUrl is derived from the user-provided serviceUrl.
      const res = await safeFetch(infoUrl);
      if (res.ok) {
        const info = (await res.json()) as {
          authInfo?: { tokenServicesUrl?: unknown };
        };
        const t = info.authInfo?.tokenServicesUrl;
        if (typeof t === 'string' && t.length > 0) return t;
      }
    } catch {
      /* fall through to host-based fallback */
    }
  }

  // Fallback: ArcGIS Online hosts services on services{N}.arcgis.com
  // and uses a single token endpoint at www.arcgis.com.
  const host = parsed.hostname.toLowerCase();
  if (host === 'arcgis.com' || host.endsWith('.arcgis.com')) {
    return 'https://www.arcgis.com/sharing/rest/generateToken';
  }
  return null;
}
