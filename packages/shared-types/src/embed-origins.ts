// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin allow-list of sites the Embed widget may frame in app
 * runtime pages. Each entry ends up in the page's CSP `frame-src`, so
 * every entry must be a bare origin with nothing a CSP parser would
 * read as a new token or directive (spaces, `;`, quotes, commas).
 *
 * Accepted: `https://host`, `http://host`, an optional port, and an
 * optional leading `*.` for subdomains (`https://*.example.org`), as
 * CSP host sources allow. A trailing slash is dropped. A path, query,
 * user info or a bare `*` is refused.
 */

/** Most entries an admin may save. */
export const EMBED_ORIGINS_MAX = 50;

const ORIGIN_RE =
  /^(https?):\/\/((?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?\/?$/;

/** Normalized origin, or null when `input` is not an acceptable entry. */
export function normalizeEmbedOrigin(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const m = ORIGIN_RE.exec(raw);
  if (!m) return null;
  const [, scheme, host, port] = m;
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
  }
  return `${scheme}://${host}${port !== undefined ? `:${port}` : ''}`;
}

/**
 * Normalizes and de-duplicates a list. Returns the bad entries too, so
 * the caller can name them instead of silently dropping them.
 */
export function normalizeEmbedOrigins(inputs: readonly string[]): {
  origins: string[];
  invalid: string[];
} {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of inputs) {
    if (entry.trim() === '') continue;
    const n = normalizeEmbedOrigin(entry);
    if (n === null) invalid.push(entry);
    else if (!origins.includes(n)) origins.push(n);
  }
  return { origins, invalid };
}
