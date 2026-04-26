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

const TOKEN_CACHE = new Map<string, { token: string; expires: number }>();

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
  const compositeKey = `${args.cacheKey}|${args.username}|${tokenUrl}`;
  const cached = TOKEN_CACHE.get(compositeKey);
  if (cached && cached.expires - 60_000 > Date.now()) {
    return cached.token;
  }

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
    res = await fetch(tokenUrl, {
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
  TOKEN_CACHE.set(compositeKey, { token: data.token, expires });
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
      const res = await fetch(infoUrl);
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
