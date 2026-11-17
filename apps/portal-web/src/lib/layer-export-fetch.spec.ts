// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CLIENT_EXPORT_MAX_FEATURES,
  EXPORT_PAGE_SIZE,
  ExportTooLargeError,
  fetchLayerFeaturesForExport,
} from './layer-export-fetch';

function pages(bodies: object[]) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const body = bodies[i++];
    return { ok: true, status: 200, json: async () => body };
  };
  return { urls, fetchImpl };
}

const geom = { type: 'Point', coordinates: [1, 2] };

describe('fetchLayerFeaturesForExport', () => {
  it('walks every page with geometry, pinned to the first snapshot', async () => {
    const { urls, fetchImpl } = pages([
      { features: [{ id: 'a', geometry: geom, properties: { n: 1 } }], nextCursor: 'c1', asOf: '2026-01-01T00:00:00.000Z' },
      { features: [{ id: 'b', geometry: geom, properties: { n: 2 } }], nextCursor: null, asOf: '2026-01-02T00:00:00.000Z' },
    ]);
    const out = await fetchLayerFeaturesForExport('item-1', 'layer-1', fetchImpl);
    expect(out).toEqual([
      { id: 'a', geometry: geom, properties: { n: 1 } },
      { id: 'b', geometry: geom, properties: { n: 2 } },
    ]);
    expect(urls[0]).toBe(
      `/api/portal/items/item-1/layers/layer-1/geojson?limit=${EXPORT_PAGE_SIZE}&cursor=`,
    );
    const second = new URL(urls[1]!, 'http://x');
    expect(second.searchParams.get('cursor')).toBe('c1');
    expect(second.searchParams.get('at')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('fails on a refused page', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchLayerFeaturesForExport('i', 'l', fetchImpl)).rejects.toThrow('(403)');
  });

  it('stops past the browser export limit', async () => {
    const big = Array.from({ length: CLIENT_EXPORT_MAX_FEATURES + 1 }, () => ({ geometry: null, properties: {} }));
    const { fetchImpl } = pages([{ features: big, nextCursor: 'c' }]);
    await expect(fetchLayerFeaturesForExport('i', 'l', fetchImpl)).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});
