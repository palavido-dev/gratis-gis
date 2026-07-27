// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The version string the running web build was made from.
 *
 * NEXT_PUBLIC_GG_VERSION is inlined at build time (Next only inlines
 * literal process.env.NEXT_PUBLIC_* references, which is why this
 * lives behind one shared constant instead of ad hoc reads). The
 * deploy and install scripts pass `git describe --tags --always`, so
 * a release build reads "v0.9.1" and a between-releases build reads
 * something like "v0.9.1-3-gabc1234", which is honest about exactly
 * what is running. Local dev, where no build arg exists, shows "dev".
 *
 * Version strings are deliberately rendered bare (no "Version" label)
 * so they need no entry in the i18n catalogs.
 */
export const GG_VERSION: string = process.env.NEXT_PUBLIC_GG_VERSION || 'dev';

/**
 * Where the version badge should link. Only release-tag builds get a
 * link (to that tag's release notes), and only when the deployment
 * advertises a public repo. A dirty or between-releases describe
 * string has no meaningful landing page, so it renders as plain text.
 */
export function versionReleaseUrl(): string | null {
  const repo = process.env.NEXT_PUBLIC_GITHUB_REPO;
  if (!repo) return null;
  if (!/^v\d+\.\d+\.\d+$/.test(GG_VERSION)) return null;
  return `https://github.com/${repo}/releases/tag/${GG_VERSION}`;
}
