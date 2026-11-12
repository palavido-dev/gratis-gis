// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical public URL for THIS portal deployment.  Used by SEO
 * helpers (sitemap, robots, openGraph, JSON-LD, canonical link
 * tags) so the same code path produces a correct absolute URL on
 * demo.gratisgis.org, on a self-hosted instance at gis.example.com,
 * and in local dev at http://localhost:3000.
 *
 * Reads `NEXT_PUBLIC_PORTAL_URL` (no trailing slash) and falls
 * back to `https://demo.gratisgis.org` for the canonical public preview.
 * Self-hosters who care about SEO should set the env var to their
 * own origin; everyone else gets a sensible default that at least
 * keeps the sitemap shape correct.
 *
 * Always returns an origin (scheme + host, no trailing slash) so
 * callers can safely concatenate `/path`.
 */
export function getPortalUrl(): string {
  const raw = process.env.NEXT_PUBLIC_PORTAL_URL?.trim();
  if (raw && raw.length > 0) {
    return raw.replace(/(?<!\/)\/+$/, '');
  }
  return 'https://demo.gratisgis.org';
}

/**
 * Build an absolute URL for a path under this portal's origin.
 * Empty / undefined / '/' all resolve to the bare origin so
 * callers don't have to special-case the landing page.
 */
export function portalUrl(path?: string): string {
  const base = getPortalUrl();
  if (!path || path === '/' || path === '') return base;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
