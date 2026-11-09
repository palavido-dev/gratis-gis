// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parse the many shapes of "this is my AGO portal URL" into the
 * canonical /sharing/rest base the rest of the importer needs.
 *
 * AGO users come at this from at least four different shapes:
 *   - org subdomain only:      palavido.maps.arcgis.com
 *   - with scheme:             https://palavido.maps.arcgis.com
 *   - with trailing slash:     https://palavido.maps.arcgis.com/
 *   - org home page:           https://palavido.maps.arcgis.com/home/
 *   - already-canonical:       https://palavido.maps.arcgis.com/sharing/rest
 *   - AGO public cloud:        https://www.arcgis.com
 *   - Enterprise portal:       https://gis.example.gov/portal
 *
 * The importer needs the /sharing/rest base. The OAuth flow also
 * needs the same base because AGO publishes /oauth2/authorize and
 * /oauth2/token under /sharing/rest. Pulling both shapes from one
 * normalized URL keeps the importer + OAuth in lockstep.
 *
 * Returns null when the input cannot be coerced into a plausible
 * https:// URL. The caller surfaces a 400 in that case.
 */

export interface NormalizedAgoUrl {
  /** Canonical /sharing/rest base, e.g.
   *  https://palavido.maps.arcgis.com/sharing/rest. No trailing
   *  slash. */
  sharingRestBase: string;
  /** Origin (scheme + host + optional port) so callers can build
   *  other URLs under the same portal (e.g. /portal/home links). */
  origin: string;
  /** The user-provided "portal path prefix" preceding /sharing/
   *  in the canonical URL. Empty for AGO public-cloud; "/portal"
   *  for typical Enterprise installs. */
  portalPath: string;
}

export function normalizeAgoUrl(raw: string): NormalizedAgoUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Add scheme if the user pasted a bare host.
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  // Refuse non-https (AGO public + most Enterprise installs are
  // https-only; allowing http would be a downgrade footgun on the
  // OAuth path).
  if (parsed.protocol !== 'https:') return null;
  // Walk the path. Three sub-cases:
  //  1. path already contains /sharing/rest -> trim everything after
  //  2. path ends in /home or /home/ -> strip; we want the portal root
  //  3. otherwise -> the path is the Enterprise portal-name prefix
  //
  // Empty path on AGO public cloud yields the standard
  // /sharing/rest base.
  const path = parsed.pathname.replace(/\/+$/, '');
  let portalPath = '';
  if (/\/sharing\/rest(\/|$)/i.test(path)) {
    portalPath = path.replace(/\/sharing\/rest.*$/i, '');
  } else if (/\/home(\/|$)/i.test(path)) {
    portalPath = path.replace(/\/home(\/.*)?$/i, '');
  } else {
    portalPath = path;
  }
  // Normalize: ensure exactly one leading slash, no trailing.
  portalPath = portalPath.replace(/\/+/g, '/').replace(/\/+$/, '');
  if (portalPath && !portalPath.startsWith('/')) {
    portalPath = `/${portalPath}`;
  }
  const sharingRestBase = `${parsed.origin}${portalPath}/sharing/rest`;
  return {
    sharingRestBase,
    origin: parsed.origin,
    portalPath,
  };
}

/**
 * Build the OAuth authorize URL the browser should send the user
 * to. Uses the implicit-grant flow (response_type=token) because
 * GratisGIS is a single-page admin context where we don't carry a
 * long-lived server-side credential store yet -- the token lives
 * only as long as the importer dialog is open.
 *
 * `state` is a CSRF token the caller generated; the callback page
 * verifies it round-tripped untampered before accepting the
 * returned token.
 */
export function buildAgoAuthorizeUrl(args: {
  sharingRestBase: string;
  clientId: string;
  redirectUri: string;
  state: string;
  expirationMinutes?: number;
}): string {
  // AGO's implicit-grant endpoint sits at /oauth2/authorize under
  // the sharing-rest base. response_type=token yields a fragment
  // (#access_token=...) on the redirect URI; the callback page
  // reads it client-side without a server round-trip.
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: 'token',
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  if (args.expirationMinutes) {
    params.set('expiration', String(args.expirationMinutes));
  }
  return `${args.sharingRestBase}/oauth2/authorize?${params.toString()}`;
}

/**
 * Origins an AGO token may be sent to for one import: the portal
 * itself, plus any federated server the portal lists. ArcGIS clients
 * only attach a portal token to the portal and its trusted servers.
 * Anything else (a county or partner ArcGIS Server registered as a
 * referenced item) is probed anonymously, so the token never lands in a
 * third party's access log.
 */
export function agoTokenOrigins(
  portalUrl: string,
  serverUrls: readonly string[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const raw of [portalUrl, ...serverUrls]) {
    try {
      out.add(new URL(raw).origin);
    } catch {
      // Not a URL; nothing to trust.
    }
  }
  return out;
}

/**
 * Whether the token may travel to `url`. Same origin as the portal or a
 * listed server, or, when the portal is ArcGIS Online, an HTTPS host
 * under arcgis.com (hosted services live on services*.arcgis.com and
 * tiles.arcgis.com, run by the same operator as the portal).
 */
export function agoTokenMayGoTo(
  url: string,
  portalUrl: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  let target: URL;
  let portal: URL;
  try {
    target = new URL(url);
    portal = new URL(portalUrl);
  } catch {
    return false;
  }
  if (trustedOrigins.has(target.origin)) return true;
  const isAgo = (host: string) =>
    host === 'arcgis.com' || host.endsWith('.arcgis.com');
  return (
    target.protocol === 'https:' &&
    isAgo(portal.hostname.toLowerCase()) &&
    isAgo(target.hostname.toLowerCase())
  );
}
