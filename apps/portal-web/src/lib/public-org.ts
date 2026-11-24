// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which organization a signed-out page is showing.
 *
 * On an install that serves one organization the API answers for that
 * organization when no org is named, so nothing here changes for it.
 * On an install that serves many, a signed-out read (landing page,
 * embed allow-list) must name the org, and for now the page's own
 * `?org=<slug>` query does that. Reading the org from the host name
 * later is a change in this file.
 */

/** Longest slug passed on; anything longer is not an org slug. */
const MAX_SLUG_LENGTH = 100;

type QueryValue = string | string[] | undefined;

/** The `org` slug a page was asked to show, or undefined. */
export function publicOrgSlug(
  query: URLSearchParams | Record<string, QueryValue> | undefined | null,
): string | undefined {
  if (!query) return undefined;
  const raw: QueryValue =
    query instanceof URLSearchParams ? (query.get('org') ?? undefined) : query.org;
  // A repeated key is ambiguous; ignore it rather than guess.
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim();
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) return undefined;
  return slug;
}

/**
 * The org slug the landing page passes to the API. A one-organization
 * install shows its own landing whatever the query says, as it always
 * has; an install serving many shows the org the page names.
 */
export function landingOrgSlug(
  query: URLSearchParams | Record<string, QueryValue> | undefined | null,
  multiTenant: boolean,
): string | undefined {
  return multiTenant ? publicOrgSlug(query) : undefined;
}

/** `path` with `?org=<slug>` added when a slug is given. */
export function withOrgQuery(path: string, slug: string | undefined): string {
  if (!slug) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}org=${encodeURIComponent(slug)}`;
}
