// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isWebMercatorEpsg,
  readProjectedEpsg,
} from './elevation-sample';

describe('readProjectedEpsg', () => {
  it('reads geotiff v3 getGeoKeys()', () => {
    expect(
      readProjectedEpsg({
        getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 3857 }),
      }),
    ).toBe(3857);
  });

  it('falls back to the geotiff v2 .geoKeys field', () => {
    expect(
      readProjectedEpsg({
        geoKeys: { ProjectedCSTypeGeoKey: 3857 },
      }),
    ).toBe(3857);
  });

  it('coerces string EPSG codes', () => {
    expect(
      readProjectedEpsg({
        getGeoKeys: () => ({ ProjectedCSTypeGeoKey: '3857' }),
      }),
    ).toBe(3857);
  });

  it('returns null when no projected CRS is present', () => {
    expect(readProjectedEpsg({ getGeoKeys: () => ({}) })).toBeNull();
    expect(readProjectedEpsg({})).toBeNull();
  });
});

describe('isWebMercatorEpsg', () => {
  it('accepts 3857 and common aliases', () => {
    expect(isWebMercatorEpsg(3857)).toBe(true);
    expect(isWebMercatorEpsg(900913)).toBe(true);
    expect(isWebMercatorEpsg(102100)).toBe(true);
  });

  it('rejects other codes and null', () => {
    expect(isWebMercatorEpsg(4326)).toBe(false);
    expect(isWebMercatorEpsg(null)).toBe(false);
  });
});
