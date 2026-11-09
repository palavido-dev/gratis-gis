// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared constants for the project website. Every link to the live
// demo goes through DEMO_URL so the move to its own subdomain is one
// edit, not a search.

export const SITE_URL = 'https://gratisgis.org';
export const DEMO_URL = 'https://demo.gratisgis.org';
export const REPO_URL = 'https://github.com/palavido-dev/gratis-gis';
export const QGIS_PLUGIN_URL = 'https://github.com/palavido-dev/gratis-gis-qgis';

export const SITE_TITLE = 'GratisGIS: self-hosted, open source GIS portal';
export const SITE_DESCRIPTION =
  'GratisGIS is a self-hosted GIS portal with web maps, PostGIS data layers, forms, dashboards and an offline field app. Open source under AGPL-3.0.';

/** A file or folder in the main repository, on the main branch. */
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

/** The current release. Update with each tagged release. */
export const CURRENT_VERSION = '1.2.0';

export interface Release {
  version: string;
  date: string;
  isoDate: string;
  summary: string;
}

/**
 * The three most recent releases, summarized from CHANGELOG.md.
 * Keep the wording to what the changelog entry says.
 */
export const RECENT_RELEASES: Release[] = [
  {
    version: '1.2.0',
    date: 'Nov 5, 2026',
    isoDate: '2026-11-05',
    summary:
      'Admin Updates page, the point-cloud worker on home NAS installs, and sanitized popup and attribution HTML.',
  },
  {
    version: '1.1.0',
    date: 'Nov 3, 2026',
    isoDate: '2026-11-03',
    summary: 'Home NAS install, @mentions in map comments, and live markup co-editing.',
  },
  {
    version: '1.0.0',
    date: 'Oct 31, 2026',
    isoDate: '2026-10-31',
    summary: 'First stable release. The public surface follows semantic versioning from here on.',
  },
];

/**
 * Top-level paths that belong to the portal, not this site. The 404
 * page sends a browser on one of these to the same path on the demo,
 * so old links to gratisgis.org/items/... keep working after the
 * portal moves. Keep in sync with apps/portal-web/src/app.
 */
export const PORTAL_PATH_PREFIXES = [
  'admin',
  'api',
  'assistant',
  'credits',
  'feedback',
  'field',
  'forms',
  'groups',
  'help',
  'items',
  'maps',
  'print',
  'print-preview',
  'profile',
  'recently-deleted',
  'settings',
  'signin',
  'whats-new',
];
