// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the vector basemap an offline package is cut from comes
 * from.
 *
 * Default is the Protomaps daily planet build. That tileset is an
 * ODbL Produced Work of OpenStreetMap data, explicitly published for
 * self-hosting, which is what makes it usable here at all: the
 * community raster tile servers the field runtime used to prefetch
 * from prohibit bulk download and offline use by name.
 *
 * Protomaps keeps each daily build for about a week and their own
 * guidance is to copy the tileset to your own storage rather than
 * read from theirs in production. `PORTAL_BASEMAP_PMTILES_URL` is
 * how an operator does that. It is deliberately not settable per
 * request: the URL is handed to a subprocess that fetches it, so
 * letting a caller choose it would be a server-side request forgery
 * primitive with extra steps.
 */

const PROTOMAPS_BUILD_BASE = 'https://build.protomaps.com';

/**
 * How many days back to look for a published build. Protomaps
 * retains roughly a week; going further is just slow failure.
 */
const MAX_LOOKBACK_DAYS = 8;

/** Attribution the client must display when rendering these tiles. */
export const BASEMAP_ATTRIBUTION =
  '© OpenStreetMap contributors, © Protomaps';

function utcDateStamp(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Does this URL currently serve an archive? */
export async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the archive to cut from.
 *
 * With the env var set, that URL is used as-is and is not probed:
 * an operator mirror that is temporarily down should surface as a
 * build failure naming the mirror, not as a silent fallback to
 * Protomaps' own servers, which is exactly the traffic the operator
 * configured the mirror to avoid.
 *
 * Without it, walks back from today until a daily build answers.
 */
export async function resolveBasemapSource(): Promise<string> {
  const configured = process.env.PORTAL_BASEMAP_PMTILES_URL?.trim();
  if (configured) {
    if (!/^https?:\/\//i.test(configured)) {
      throw new Error(
        'PORTAL_BASEMAP_PMTILES_URL must be an http or https URL.',
      );
    }
    return configured;
  }
  for (let daysAgo = 0; daysAgo < MAX_LOOKBACK_DAYS; daysAgo += 1) {
    const url = `${PROTOMAPS_BUILD_BASE}/${utcDateStamp(daysAgo)}.pmtiles`;
    if (await isReachable(url)) return url;
  }
  throw new Error(
    'No published basemap build could be reached. Set PORTAL_BASEMAP_PMTILES_URL to a mirror.',
  );
}
