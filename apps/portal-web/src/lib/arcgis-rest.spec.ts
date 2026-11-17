// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import {
  exceededTransferLimit,
  extentToBbox,
  fetchLayerBBox,
  serviceName,
} from './arcgis-rest';

describe('serviceName', () => {
  const fs = 'https://host/arcgis/rest/services/Parcels/FeatureServer';
  it('takes the name from a FeatureServer URL', () => {
    expect(serviceName({}, fs)).toBe('Parcels');
  });
  it('skips an empty serviceDescription', () => {
    expect(serviceName({ serviceDescription: '' }, fs)).toBe('Parcels');
  });
  it('prefers mapName', () => {
    expect(
      serviceName({ mapName: 'Layers' }, 'https://h/rest/services/A/MapServer'),
    ).toBe('Layers');
  });
  it('handles GeocodeServer and a layer URL', () => {
    expect(serviceName({}, 'https://h/rest/services/Geo/World/GeocodeServer')).toBe('World');
    expect(serviceName({}, `${fs}/0`)).toBe('Parcels');
  });
  it('falls back when nothing names it', () => {
    expect(serviceName({}, 'https://h/whatever')).toBe('ArcGIS layer');
  });
});

describe('extentToBbox', () => {
  const projected = { xmin: 6_200_000, ymin: 1_800_000, xmax: 6_300_000, ymax: 1_900_000 };
  it('drops a projected extent that only carries wkt', () => {
    expect(
      extentToBbox({ ...projected, spatialReference: { wkt: 'PROJCS[...]' } }),
    ).toBeNull();
  });
  it('drops a projected extent with no spatial reference', () => {
    expect(extentToBbox(projected)).toBeNull();
  });
  it('drops a Web Mercator extent', () => {
    expect(
      extentToBbox({ ...projected, spatialReference: { wkid: 102100, latestWkid: 3857 } }),
    ).toBeNull();
  });
  it('keeps WGS84 by wkid or latestWkid', () => {
    const ll = { xmin: -120, ymin: 33, xmax: -117, ymax: 35 };
    expect(extentToBbox({ ...ll, spatialReference: { wkid: 4326 } })).toEqual([-120, 33, -117, 35]);
    expect(extentToBbox({ ...ll, spatialReference: { latestWkid: 4326 } })).toEqual([-120, 33, -117, 35]);
    expect(extentToBbox(ll)).toEqual([-120, 33, -117, 35]);
  });
});

describe('exceededTransferLimit', () => {
  it('reads the flag at the top level or under properties', () => {
    expect(exceededTransferLimit({ exceededTransferLimit: true })).toBe(true);
    expect(exceededTransferLimit({ properties: { exceededTransferLimit: true } })).toBe(true);
    expect(exceededTransferLimit({ properties: null })).toBe(false);
    expect(exceededTransferLimit(null)).toBe(false);
  });
});

describe('fetchLayerBBox', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('keeps paging when the server reports the flag under properties', async () => {
    const feature = { type: 'Feature', geometry: null, properties: {} };
    const pages = [
      { type: 'FeatureCollection', features: [feature, feature], properties: { exceededTransferLimit: true } },
      { type: 'FeatureCollection', features: [feature] },
    ];
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(pages.shift())));
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchLayerBBox('https://h/rest/services/A/FeatureServer', 0, [0, 0, 1, 1], {
      pageSize: 2,
    });
    expect(out.featureCollection.features).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
