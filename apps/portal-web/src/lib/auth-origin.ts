// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which browser origin may start Keycloak sign-in.
 *
 * A NAS install records one public URL at boot (the LAN address, unless
 * GRATIS_BASE_URL says otherwise). NextAuth uses that URL for the OAuth
 * redirect, and Keycloak's frontend URL sends the browser there too.
 * Opening the portal through a Tailscale hostname used to bounce login
 * to the LAN address. Sign-in now refuses a different host and tells
 * the operator the line to set, instead of starting that redirect.
 */

export interface SignInOriginDecision {
  /** Configured origin, no trailing slash. Empty when unset. */
  canonical: string;
  /** Host header the browser (or the proxy) sent, unchanged. */
  openedHost: string;
  /** True when this request may start the Keycloak redirect. */
  allowed: boolean;
  /**
   * Value to put in GRATIS_BASE_URL. A MagicDNS name with no port is
   * the Tailscale Serve HTTPS address. Any other host keeps http,
   * which is how the portal port is published.
   */
  suggestedBaseUrl: string;
}

/** Compose value for the host the browser actually opened. */
export function suggestedBaseUrl(openedHost: string): string {
  const hostname = openedHost.split(':')[0] ?? openedHost;
  const hasPort = openedHost.includes(':');
  if (hostname.endsWith('.ts.net') && !hasPort) return `https://${hostname}`;
  if (!openedHost) return '';
  return `http://${openedHost}`;
}

function canonicalOrigin(env: NodeJS.ProcessEnv): string {
  const raw = (env.NEXTAUTH_URL || env.PUBLIC_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return '';
  }
}

/** Host header value, first entry, no scheme. */
export function requestHost(hostHeader: string | null | undefined): string {
  return (hostHeader ?? '').split(',')[0]?.trim() ?? '';
}

/**
 * Allow sign-in when the Host header is the configured origin.
 * The comparison ignores the scheme Caddy observed. Tailscale Serve
 * terminates TLS and then dials the portal over plain HTTP, so the
 * proxy's protocol is not the browser's. The hostname and port are.
 */
export function decideSignInOrigin(
  hostHeader: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SignInOriginDecision {
  const canonical = canonicalOrigin(env);
  const openedHost = requestHost(hostHeader);
  if (!canonical || !openedHost) {
    return {
      canonical,
      openedHost,
      allowed: !canonical,
      suggestedBaseUrl: suggestedBaseUrl(openedHost),
    };
  }
  let allowedHost = '';
  try {
    allowedHost = new URL(canonical).host;
  } catch {
    allowedHost = '';
  }
  const allowed = openedHost.toLowerCase() === allowedHost.toLowerCase();
  return {
    canonical,
    openedHost,
    allowed,
    suggestedBaseUrl: suggestedBaseUrl(openedHost),
  };
}
