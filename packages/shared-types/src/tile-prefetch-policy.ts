// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * May we pre-fetch this tile source for offline use?
 *
 * Caching a tile someone just looked at and pre-fetching thousands
 * they have not are different acts, and tile providers treat them
 * differently. OpenStreetMap's Tile Usage Policy requires the first
 * (cache for at least 7 days) and prohibits the second in terms that
 * name this feature directly: section 4 lists "pre-seeding large
 * areas or multiple zoom levels in advance" and "building tile
 * archives for later distribution" as bulk downloading, and states
 * that "offline use is not permitted on tile.openstreetmap.org",
 * calling out "download city for offline use" style features
 * specifically. Enforcement is blocking without notice.
 *
 * So this classifier gates the WARMER and any future server-side
 * packager. It must not be used to gate ordinary runtime caching:
 * caching what the reader is actually viewing is permitted, and for
 * OSM it is required.
 *
 * Unknown hosts default to NOT prefetching. That is the
 * uncomfortable-but-correct default: the failure mode of guessing
 * "allowed" is silently hammering someone else's infrastructure on
 * every operator's behalf, and they find out when they get blocked.
 * An operator who knows their provider permits it, or who pays for a
 * plan that does, can say so explicitly.
 */

export type TilePrefetchVerdict = 'allowed' | 'prohibited' | 'unknown';

export interface TilePrefetchPolicy {
  verdict: TilePrefetchVerdict;
  /** Host the decision was made about, or 'self' for our own origin. */
  host: string;
  /** Short human-readable reason, safe to show in the UI. */
  reason: string;
}

/**
 * Hosts whose terms specifically forbid prefetch / offline use.
 * Keep the reason provider-specific: "your basemap does not allow
 * offline downloads" is useless to someone deciding what to do next.
 */
const PROHIBITED: Array<{ test: (host: string) => boolean; reason: string }> = [
  {
    // a/b/c subdomains are deprecated but still appear in old configs.
    test: (h) => h === 'tile.openstreetmap.org' || /\.tile\.openstreetmap\.org$/.test(h),
    reason:
      "OpenStreetMap's tile policy prohibits offline downloads and bulk pre-fetching.",
  },
  {
    test: (h) => h === 'cartocdn.com' || /\.cartocdn\.com$/.test(h),
    reason:
      "Carto's hosted basemaps are not licensed for bulk download or offline redistribution.",
  },
];

/**
 * Hosts we can prefetch. Deliberately short. Anything added here
 * needs a real reason recorded, not an assumption.
 */
const ALLOWED: Array<{ test: (host: string) => boolean; reason: string }> = [
  {
    // Work of the US federal government, public domain.
    test: (h) => h === 'basemap.nationalmap.gov' || /\.nationalmap\.gov$/.test(h),
    reason: 'USGS National Map imagery is US federal public domain.',
  },
];

/**
 * Classify one tile URL template.
 *
 * Relative URLs are ours: the portal's own MVT endpoint, a
 * self-hosted PMTiles or COG served out of our storage. Those we may
 * obviously package.
 */
export function tilePrefetchPolicy(
  urlTemplate: string,
  selfOrigin?: string,
): TilePrefetchPolicy {
  const trimmed = urlTemplate.trim();

  // pmtiles:// and cog:// wrap an inner URL; judge that instead.
  const unwrapped = trimmed.replace(/^(pmtiles|cog):\/\//, '');

  if (unwrapped.startsWith('/')) {
    return {
      verdict: 'allowed',
      host: 'self',
      reason: 'Served by this portal.',
    };
  }

  let host: string;
  try {
    host = new URL(unwrapped).hostname.toLowerCase();
  } catch {
    // Not a URL we can reason about. Refuse rather than guess.
    return {
      verdict: 'unknown',
      host: unwrapped.slice(0, 60),
      reason: 'Could not identify the tile provider.',
    };
  }

  if (selfOrigin) {
    try {
      if (host === new URL(selfOrigin).hostname.toLowerCase()) {
        return {
          verdict: 'allowed',
          host,
          reason: 'Served by this portal.',
        };
      }
    } catch {
      // A malformed selfOrigin is not a reason to fail the check.
    }
  }

  for (const rule of PROHIBITED) {
    if (rule.test(host)) return { verdict: 'prohibited', host, reason: rule.reason };
  }
  for (const rule of ALLOWED) {
    if (rule.test(host)) return { verdict: 'allowed', host, reason: rule.reason };
  }

  return {
    verdict: 'unknown',
    host,
    reason:
      'This provider has not been confirmed to allow offline downloads. Host the basemap yourself to take it into the field.',
  };
}

export interface TilePrefetchSplit {
  /** Templates safe to pre-fetch. */
  allowed: string[];
  /** Everything refused, with why, for the UI to explain. */
  refused: Array<{ template: string } & TilePrefetchPolicy>;
}

/** Partition a template list into what may and may not be prefetched. */
export function splitByPrefetchPolicy(
  urlTemplates: string[],
  selfOrigin?: string,
): TilePrefetchSplit {
  const allowed: string[] = [];
  const refused: TilePrefetchSplit['refused'] = [];
  for (const template of urlTemplates) {
    const policy = tilePrefetchPolicy(template, selfOrigin);
    if (policy.verdict === 'allowed') allowed.push(template);
    else refused.push({ template, ...policy });
  }
  return { allowed, refused };
}
