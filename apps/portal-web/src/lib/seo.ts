// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Search-engine settings shared by the root layout, the home page,
 * the help pages and the sitemap.
 */

/**
 * A public test instance (NEXT_PUBLIC_PUBLIC_TESTING=1, the project's
 * demo at demo.gratisgis.org). Every page on it asks search engines
 * not to index it: the home page repeats the project website's pitch,
 * and the help pages are published on the project website, so an
 * indexed copy here would only compete with them.
 */
export const IS_PUBLIC_TEST_INSTANCE = process.env.NEXT_PUBLIC_PUBLIC_TESTING === '1';

/**
 * Where the public copy of the help lives. The project website builds
 * its /help pages from the same content/help files, with the same
 * slugs, so a help page on any portal names that copy as canonical.
 * A self-hosted portal's help is a copy of the project's
 * documentation, and search engines should send readers to one place.
 */
export const PUBLIC_HELP_ORIGIN = 'https://gratisgis.org';

/** Canonical URL of a help page on the project website. Empty slug = /help. */
export function publicHelpUrl(slug: string): string {
  return slug ? `${PUBLIC_HELP_ORIGIN}/help/${slug}` : `${PUBLIC_HELP_ORIGIN}/help`;
}
