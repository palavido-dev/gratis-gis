// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * Popup Edit must open the form on the record, not on the tile. The
 * tile never carries `_observation_id`, so editing from it sent no
 * base id and the server could not refuse a stale overwrite.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { putFeatures } from './offline-store';
import { loadFeatureForEdit } from './field-edit-source';

const BASE = {
  dataCollectionId: 'dc-1',
  dataLayerId: 'dl-1',
  layerKey: 'main',
  globalId: 'f-1',
  tile: { properties: { owner: 'stale' }, geometry: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('loadFeatureForEdit', () => {
  it('uses the server record, observation id included, when online', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'f-1',
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: { owner: 'fresh', _global_id: 'f-1', _observation_id: 'obs-9' },
          },
        ],
      }),
    );
    const out = await loadFeatureForEdit({
      ...BASE,
      isOnline: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.source).toBe('server');
    expect(out.properties._observation_id).toBe('obs-9');
    expect(out.properties.owner).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/portal/items/dl-1/layers/main/features?entity=f-1',
      expect.anything(),
    );
  });

  it('falls back to the device copy when the server read fails', async () => {
    await putFeatures([
      {
        dataCollectionId: 'dc-1',
        dataLayerId: 'dl-1',
        layerKey: 'main',
        globalId: 'f-1',
        feature: {
          type: 'Feature',
          id: 'f-1',
          geometry: { type: 'Point', coordinates: [3, 4] },
          properties: { owner: 'device', _observation_id: 'obs-3' },
        },
        cachedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const fetchImpl = jest.fn(async () => jsonResponse({}, 502));
    const out = await loadFeatureForEdit({
      ...BASE,
      isOnline: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.source).toBe('device');
    expect(out.properties._observation_id).toBe('obs-3');
  });

  it('does not call the network offline and uses the tile when nothing is cached', async () => {
    const fetchImpl = jest.fn();
    const out = await loadFeatureForEdit({
      ...BASE,
      isOnline: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.source).toBe('tile');
    expect(out.properties.owner).toBe('stale');
  });

  it('encodes ids into the URL', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ features: [] }));
    await loadFeatureForEdit({
      ...BASE,
      globalId: 'a/b?c',
      isOnline: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      '/api/portal/items/dl-1/layers/main/features?entity=a%2Fb%3Fc',
    );
  });
});
