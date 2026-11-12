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

export interface CachedToken {
  token: string;
  expires: number;
  /** Keyed digest of the password that minted the token, so a
   *  replaced password is never answered with the old one's token.
   *  The password itself is not kept: a credential cleared from an
   *  item used to stay in API memory for the life of the process. */
  passwordDigest: Buffer;
}

/** Most entries kept. The probe route keys by the URL the caller
 *  sends, so the cache grew by one entry per distinct URL forever. */
const TOKEN_CACHE_MAX = 500;
const TOKEN_CACHE = new Map<string, CachedToken>();

/**
 * Referer the exchanged token is bound to (client=referer). Every
 * data call that uses such a token must send it as its Referer
 * header, or a server that enforces the binding answers "invalid
 * token".
 */
export const ARCGIS_TOKEN_REFERER = 'https://gratisgis.local';

/**
 * Discovered token endpoints, per REST root. Discovery is an upstream
 * GET, and the exchange used to run it before every cache lookup, so
 * every proxied tile paid an extra round trip. Ten minutes is short
 * enough to follow a server that moves its token service.
 */
const TOKEN_URL_TTL_MS = 10 * 60_000;
const TOKEN_URL_CACHE = new Map<string, { tokenUrl: string; expires: number }>();

/** Small cap and timeout for the /info discovery read. */
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 256 * 1024;

/**
 * Failed exchanges, kept briefly. Without this every request to an
 * item whose stored password no longer works (including anonymous
 * requests through the public proxy) submitted another failed login
 * upstream on the owner's behalf, which can lock the account.
 */
const FAILED_EXCHANGE_TTL_MS = 60_000;
const FAILED_EXCHANGES = new Map<
  string,
  { message: string; expires: number; passwordDigest: Buffer }
>();

/** Test hook: forget every cached token, endpoint and failure. */
export function resetArcgisAuthCaches(): void {
  TOKEN_CACHE.clear();
  TOKEN_URL_CACHE.clear();
  FAILED_EXCHANGES.clear();
}

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
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

import { safeFetch } from '../common/net-guards.js';

/** Ceiling for the /info and generateToken replies, both small JSON. */
const ARCGIS_AUTH_MAX_BYTES = 1024 * 1024;

/** Per-process key for the password digests. Nothing outside this
 *  process can recompute a digest. */
const DIGEST_KEY = randomBytes(32);

/** Iterations for the in-memory digest. The digest only identifies a
 *  credential inside this process (the cache key and the equality
 *  check), never leaves it and is never stored, so a small count is
 *  enough; a key derivation function keeps the plain password out of
 *  the cache without a fast hash of it. */
const DIGEST_ITERATIONS = 2_000;

export function passwordDigest(password: string): Buffer {
  return pbkdf2Sync(password, DIGEST_KEY, DIGEST_ITERATIONS, 32, 'sha256');
}

/** Look up an entry, dropping it when expired. A hit moves the entry
 *  to the back so the oldest unused one is evicted first. */
function cacheGet(key: string, now: number = Date.now()): CachedToken | undefined {
  const entry = TOKEN_CACHE.get(key);
  if (!entry) return undefined;
  TOKEN_CACHE.delete(key);
  if (entry.expires <= now) return undefined;
  TOKEN_CACHE.set(key, entry);
  return entry;
}

export function cacheSet(key: string, entry: CachedToken): void {
  TOKEN_CACHE.delete(key);
  TOKEN_CACHE.set(key, entry);
  while (TOKEN_CACHE.size > TOKEN_CACHE_MAX) {
    const oldest = TOKEN_CACHE.keys().next().value;
    if (oldest === undefined) break;
    TOKEN_CACHE.delete(oldest);
  }
}

/** For tests. */
export function tokenCacheSize(): number {
  return TOKEN_CACHE.size;
}

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
 * constant time, on keyed digests.
 */
export function reusableToken(
  entry: CachedToken | undefined,
  password: string,
  now: number = Date.now(),
): string | null {
  if (!entry || entry.expires - 60_000 <= now) return null;
  if (!sameDigest(entry.passwordDigest, passwordDigest(password))) return null;
  return entry.token;
}

/** Constant-time comparison of two password digests. */
function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
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
  const cached = reusableToken(cacheGet(compositeKey), args.password);
  if (cached !== null) return cached;

  const failed = FAILED_EXCHANGES.get(compositeKey);
  if (
    failed &&
    failed.expires > Date.now() &&
    sameDigest(failed.passwordDigest, passwordDigest(args.password))
  ) {
    throw new Error(failed.message);
  }
  try {
    return await mintToken(args, tokenUrl, compositeKey);
  } catch (err) {
    FAILED_EXCHANGES.set(compositeKey, {
      message: err instanceof Error ? err.message : String(err),
      expires: Date.now() + FAILED_EXCHANGE_TTL_MS,
      passwordDigest: passwordDigest(args.password),
    });
    throw err;
  }
}

async function mintToken(
  args: { username: string; password: string },
  tokenUrl: string,
  compositeKey: string,
): Promise<string> {

  const body = new URLSearchParams({
    f: 'json',
    username: args.username,
    password: args.password,
    // 'referer' clients are required by AGO's username/password
    // path; the referer string just needs to be consistent between
    // generateToken and the actual data call. The data call sends it
    // as its Referer header (see composeUpstreamHeaders).
    client: 'referer',
    referer: ARCGIS_TOKEN_REFERER,
    expiration: '60',
  });
  let res: Response;
  try {
    // tokenUrl is derived from the user-provided serviceUrl via the
    // /info?f=json discovery step; route through safeFetch so an
    // attacker can't redirect token exchange to an internal host.
    res = await safeFetch(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      // A token reply is a few hundred bytes. The host is chosen by
      // the item's author, so do not buffer up to the 1 GiB default.
      { maxBytes: ARCGIS_AUTH_MAX_BYTES },
    );
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
  cacheSet(compositeKey, {
    token: data.token,
    expires,
    passwordDigest: passwordDigest(args.password),
  });
  FAILED_EXCHANGES.delete(compositeKey);
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
    const hit = TOKEN_URL_CACHE.get(infoUrl);
    if (hit && hit.expires > Date.now()) {
      return hit.tokenUrl;
    }
    try {
      // infoUrl is derived from the user-provided serviceUrl.
      const res = await safeFetch(
        infoUrl,
        { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) },
        { maxBytes: DISCOVERY_MAX_BYTES },
      );
      if (res.ok) {
        const info = (await res.json()) as {
          authInfo?: { tokenServicesUrl?: unknown };
        };
        const t = info.authInfo?.tokenServicesUrl;
        if (typeof t === 'string' && t.length > 0) {
          TOKEN_URL_CACHE.set(infoUrl, {
            tokenUrl: t,
            expires: Date.now() + TOKEN_URL_TTL_MS,
          });
          return t;
        }
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
