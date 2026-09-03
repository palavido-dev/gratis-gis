// SPDX-License-Identifier: AGPL-3.0-or-later
import { pickDefaultBasemap } from './default-basemap.js';

describe('pickDefaultBasemap', () => {
  const positron = { id: 'p', data: { seededKey: 'positron' } };
  const osm = { id: 'o', data: { seededKey: 'osm' } };
  const custom = { id: 'c', data: { tileUrl: 'https://x/{z}/{x}/{y}.png' } };

  it('prefers the seeded OpenStreetMap basemap wherever it sits', () => {
    // Positron is seeded first on every existing org, so "earliest"
    // is exactly the wrong tie-break: its tiles carry a Carto
    // watermark without an API key.
    expect(pickDefaultBasemap([positron, osm, custom])).toBe(osm);
    expect(pickDefaultBasemap([custom, positron, osm])).toBe(osm);
  });

  it('falls back to any seeded basemap, then to the oldest item', () => {
    expect(pickDefaultBasemap([custom, positron])).toBe(positron);
    expect(pickDefaultBasemap([custom, { id: 'd', data: null }])).toBe(custom);
  });

  it('returns null when the org has no basemap at all', () => {
    expect(pickDefaultBasemap([])).toBeNull();
  });
});
