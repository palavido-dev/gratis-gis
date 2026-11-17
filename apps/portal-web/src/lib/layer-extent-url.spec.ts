// SPDX-License-Identifier: AGPL-3.0-or-later
import { layerExtentUrl } from './layer-extent-url';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('layerExtentUrl', () => {
  it('asks the server for a v3 sublayer, with its filter', () => {
    expect(layerExtentUrl({ kind: 'data-layer', itemId: ID, layerKey: 'parcels' })).toBe(
      `/api/portal/items/${ID}/layers/parcels/filtered-extent`,
    );
    const url = layerExtentUrl(
      { kind: 'data-layer', itemId: ID, layerKey: 'parcels' },
      { combinator: 'all', clauses: [{ field: 'city', op: '==', value: 'Hemet' }] },
    )!;
    const where = new URL(url, 'http://x').searchParams.get('where');
    expect(JSON.parse(where!)).toEqual({
      combinator: 'all',
      clauses: [{ field: 'city', op: '==', value: 'Hemet' }],
    });
  });

  it('reads the sublayer out of an Editor target url', () => {
    expect(
      layerExtentUrl({ kind: 'geojson-url', url: `/api/portal/items/${ID}/layers/wells/geojson` }),
    ).toBe(`/api/portal/items/${ID}/layers/wells/filtered-extent`);
  });

  it('has no answer for sources the server cannot measure', () => {
    expect(layerExtentUrl({ kind: 'data-layer', itemId: ID })).toBeNull();
    expect(layerExtentUrl({ kind: 'data-layer', itemId: '../scripts', layerKey: 'x' })).toBeNull();
    expect(layerExtentUrl({ kind: 'geojson-url', url: 'https://example.com/a.geojson' })).toBeNull();
    expect(layerExtentUrl({ kind: 'postgis-live' })).toBeNull();
  });
});
