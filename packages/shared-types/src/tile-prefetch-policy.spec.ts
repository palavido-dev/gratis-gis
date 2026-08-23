// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  tilePrefetchPolicy,
  splitByPrefetchPolicy,
} from './tile-prefetch-policy';

/**
 * The failure this guards against is not a crash. It is quietly
 * pre-fetching a million tiles from a community-funded server, which
 * looks like nothing at all until the provider blocks the whole
 * deployment. So the important cases here are the refusals, and
 * especially the default for a host nobody has classified.
 */

describe('tilePrefetchPolicy', () => {
  it('refuses OpenStreetMap, whose policy names this feature', () => {
    const p = tilePrefetchPolicy(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(p.verdict).toBe('prohibited');
    expect(p.reason).toMatch(/OpenStreetMap/);
  });

  it('refuses the deprecated a/b/c OSM subdomains too', () => {
    for (const h of ['a', 'b', 'c']) {
      expect(
        tilePrefetchPolicy(`https://${h}.tile.openstreetmap.org/{z}/{x}/{y}.png`)
          .verdict,
      ).toBe('prohibited');
    }
  });

  it('refuses Carto, including the raster tile path', () => {
    expect(
      tilePrefetchPolicy(
        'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ).verdict,
    ).toBe('prohibited');
    expect(
      tilePrefetchPolicy(
        'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ).verdict,
    ).toBe('prohibited');
  });

  it('allows USGS imagery, which is federal public domain', () => {
    const p = tilePrefetchPolicy(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    );
    expect(p.verdict).toBe('allowed');
  });

  it('allows our own relative endpoints', () => {
    expect(
      tilePrefetchPolicy('/api/portal/items/abc/layers/x/tile/{z}/{x}/{y}.mvt')
        .verdict,
    ).toBe('allowed');
  });

  it('allows our own origin when given one', () => {
    expect(
      tilePrefetchPolicy(
        'https://gratisgis.org/api/portal/tile-layer/abc/file',
        'https://gratisgis.org',
      ).verdict,
    ).toBe('allowed');
  });

  it('sees through pmtiles:// and cog:// wrappers', () => {
    expect(tilePrefetchPolicy('pmtiles:///api/portal/x').verdict).toBe(
      'allowed',
    );
    expect(
      tilePrefetchPolicy('pmtiles://https://tile.openstreetmap.org/x').verdict,
    ).toBe('prohibited');
  });

  it('defaults an unclassified provider to unknown, not allowed', () => {
    // The whole point. Guessing "allowed" here is how you end up
    // hammering a stranger's tile server on every operator's behalf.
    const p = tilePrefetchPolicy('https://tiles.example.com/{z}/{x}/{y}.png');
    expect(p.verdict).toBe('unknown');
    expect(p.verdict).not.toBe('allowed');
  });

  it('refuses rather than guesses on an unparseable template', () => {
    expect(tilePrefetchPolicy('not a url at all').verdict).toBe('unknown');
  });

  it('ignores a malformed selfOrigin instead of throwing', () => {
    expect(() =>
      tilePrefetchPolicy('https://tiles.example.com/{z}/{x}/{y}.png', 'nonsense'),
    ).not.toThrow();
  });
});

describe('splitByPrefetchPolicy', () => {
  it('keeps the allowed ones and explains each refusal', () => {
    const { allowed, refused } = splitByPrefetchPolicy([
      '/api/portal/items/a/layers/l/tile/{z}/{x}/{y}.mvt',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    ]);
    expect(allowed).toHaveLength(2);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason.length).toBeGreaterThan(10);
  });

  it('returns nothing allowed when every source is third-party', () => {
    // The demo's default basemap is Carto, so this is the live case:
    // the download must still run for features and forms, just
    // without pre-seeding a basemap.
    const { allowed, refused } = splitByPrefetchPolicy([
      'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ]);
    expect(allowed).toEqual([]);
    expect(refused).toHaveLength(1);
  });
});
