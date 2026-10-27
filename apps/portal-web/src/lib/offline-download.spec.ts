// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The pure parts of the download manager.
 *
 * `downloadDeployment` itself is a long fetch walk and is exercised by
 * hand; the pieces below are the decisions it makes that a unit test
 * can pin: the pre-flight byte estimate, quota recognition, URL
 * builders for GeoJSON / delta, and applying a delta page to upsert
 * and delete lists (including the truncated page-by-version loop with
 * mocked fetch + IndexedDB).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import {
  applyDeltaChanges,
  buildDeltaUrl,
  buildFeatureUrl,
  downloadDeployment,
  estimateDownloadBytes,
  isQuotaError,
  type LayerDeltaChange,
  type LayerDeltaResponse,
} from './offline-download';
import { estimateTileCount, WARMER_MAX_TILES } from './offline-tile-warmer';
import {
  getDeployment,
  listFeaturesForLayer,
  putDeployment,
  putFeatures,
  type CachedDeployment,
} from './offline-store';

const BBOX: [number, number, number, number] = [-122.5, 37.7, -122.3, 37.9];

describe('estimateDownloadBytes', () => {
  it('charges features and headroom with no tiles configured', () => {
    // 2 layers * 50 assumed features * 800 bytes, plus the 5 MB
    // forms-and-pick-lists headroom.
    expect(estimateDownloadBytes({ layers: [{}, {}] })).toBe(
      2 * 50 * 800 + 5 * 1024 * 1024,
    );
  });

  it('adds the warmer tile walk, once per template', () => {
    const base = estimateDownloadBytes({ layers: [{}] });
    const one = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
    });
    const two = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png', 'https://b/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
    });
    const perTemplate = estimateTileCount(BBOX, [12, 14]) * 25_000;
    expect(perTemplate).toBeGreaterThan(0);
    expect(one - base).toBe(perTemplate);
    // The warmer fetches the bbox once per source, so the estimate
    // has to as well.
    expect(two - base).toBe(2 * perTemplate);
  });

  it('caps the tile count where the warmer caps its walk', () => {
    // A continent at z19 would enumerate billions of tiles; the warmer
    // stops at WARMER_MAX_TILES, so an estimate above that would refuse
    // a download the warmer would have truncated to fit.
    const huge = estimateDownloadBytes({
      layers: [],
      bbox: [-180, -85, 180, 85],
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 19],
    });
    expect(huge).toBe(5 * 1024 * 1024 + WARMER_MAX_TILES * 25_000);
  });

  it('ignores tiles when no bbox is given', () => {
    // The warmer cannot walk an unbounded area, and the download
    // manager skips warming without a bbox, so nothing to charge.
    expect(
      estimateDownloadBytes({
        layers: [{}],
        tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      }),
    ).toBe(estimateDownloadBytes({ layers: [{}] }));
  });

  it('charges prepared packages instead of tiles when both are present', () => {
    // A prepared package replaces tile warming outright in
    // downloadDeployment, so the two are never both paid for.
    const est = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
      preparedPackages: [
        { areaId: 'a', packageId: 'p1' },
        { areaId: 'b', packageId: 'p2' },
      ],
    });
    expect(est).toBe(50 * 800 + 5 * 1024 * 1024 + 2 * 25 * 1024 * 1024);
  });
});

describe('isQuotaError', () => {
  it('recognises the standard DOMException name', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(
      true,
    );
  });

  it('recognises the legacy Firefox name and code 22', () => {
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
    expect(isQuotaError({ name: 'AbortError' })).toBe(false);
  });
});

describe('buildFeatureUrl / buildDeltaUrl', () => {
  it('builds the per-layer GeoJSON path and optional bbox query', () => {
    expect(buildFeatureUrl('dl-1', 'sites', undefined)).toBe(
      '/api/portal/items/dl-1/layers/sites/geojson',
    );
    const withBbox = buildFeatureUrl('dl-1', 'sites', BBOX);
    expect(withBbox.startsWith('/api/portal/items/dl-1/layers/sites/geojson?')).toBe(
      true,
    );
    expect(new URL(withBbox, 'https://example.test').searchParams.get('bbox')).toBe(
      BBOX.join(','),
    );
  });

  it('encodes the layer key and carries since / limit on delta', () => {
    expect(buildDeltaUrl('dl-1', 'main/a', 7)).toBe(
      '/api/portal/items/dl-1/layers/main%2Fa/delta?since=7',
    );
    expect(buildDeltaUrl('dl-1', 'main', 0, 1)).toBe(
      '/api/portal/items/dl-1/layers/main/delta?since=0&limit=1',
    );
  });
});

describe('applyDeltaChanges', () => {
  const ctx = {
    dataCollectionId: 'dc-1',
    dataLayerId: 'dl-1',
    layerKey: 'main',
    cachedAt: '2026-10-27T00:00:00.000Z',
  };

  function change(
    over: Partial<LayerDeltaChange> & Pick<LayerDeltaChange, 'entity' | 'kind'>,
  ): LayerDeltaChange {
    return {
      observationId: `obs-${over.entity}-${over.kind}`,
      syncVersion: 1,
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: over.entity },
      ...over,
    };
  }

  it('upserts create / update / derive / observe by entity id', () => {
    const { upserts, deletes } = applyDeltaChanges(
      [
        change({ entity: 'a', kind: 'create' }),
        change({
          entity: 'b',
          kind: 'update',
          properties: { name: 'bee' },
          geometry: { type: 'Point', coordinates: [3, 4] },
        }),
        change({ entity: 'c', kind: 'derive', properties: { d: 1 } }),
        change({ entity: 'd', kind: 'observe', properties: { o: true } }),
      ],
      ctx,
    );
    expect(deletes).toEqual([]);
    expect(upserts.map((r) => r.globalId).sort()).toEqual(['a', 'b', 'c', 'd']);
    const b = upserts.find((r) => r.globalId === 'b')!;
    expect(b.feature.properties).toEqual({ name: 'bee', _global_id: 'b' });
    expect(b.feature.geometry).toEqual({ type: 'Point', coordinates: [3, 4] });
    expect(b.feature.id).toBe('b');
  });

  it('collects delete tombstones and lets a later delete win', () => {
    const { upserts, deletes } = applyDeltaChanges(
      [
        change({ entity: 'gone', kind: 'create' }),
        change({ entity: 'gone', kind: 'delete', geometry: null, properties: null }),
        change({ entity: 'keep', kind: 'create' }),
      ],
      ctx,
    );
    expect(deletes).toEqual(['gone']);
    expect(upserts.map((r) => r.globalId)).toEqual(['keep']);
  });

  it('lets a later upsert revive an entity deleted earlier in the page', () => {
    const { upserts, deletes } = applyDeltaChanges(
      [
        change({ entity: 'x', kind: 'delete', geometry: null, properties: null }),
        change({ entity: 'x', kind: 'create', properties: { back: true } }),
      ],
      ctx,
    );
    expect(deletes).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.feature.properties).toEqual({
      back: true,
      _global_id: 'x',
    });
  });
});

describe('downloadDeployment delta refresh', () => {
  const DC = 'dc-delta-1';
  const LAYER = {
    dataLayerId: 'dl-1',
    layerKey: 'main',
    layerLabel: 'Sites',
    fields: [] as import('@gratis-gis/shared-types').FeatureField[],
  };

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function manifest(syncVersion?: number): CachedDeployment {
    const layerSchemas: CachedDeployment['layerSchemas'] = {
      'dl-1:main': {
        dataLayerId: 'dl-1',
        layerKey: 'main',
        schemaHash: 'hash',
        fields: [],
        ...(typeof syncVersion === 'number' ? { syncVersion } : {}),
      },
    };
    return {
      dataCollectionId: DC,
      title: 'Delta Test',
      slug: 'delta-test',
      mapId: 'map-1',
      layerSchemas,
      cachedAt: '2026-10-01T00:00:00.000Z',
      estimatedSize: 0,
    };
  }

  it('full GeoJSON pull seeds syncVersion from delta?since=0', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/geojson')) {
        return jsonResponse({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'f1',
              geometry: { type: 'Point', coordinates: [0, 0] },
              properties: { _global_id: 'f1', name: 'one' },
            },
          ],
        });
      }
      if (url.includes('/delta?since=0&limit=1')) {
        return jsonResponse({
          syncVersion: 42,
          since: 0,
          changes: [],
          truncated: false,
        } satisfies LayerDeltaResponse);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadDeployment(
      {
        dataCollectionId: DC,
        title: 'Delta Test',
        mapId: 'map-1',
        layers: [LAYER],
        pickListIds: [],
      },
      () => {},
    );

    expect(result.layerSchemas['dl-1:main']?.syncVersion).toBe(42);
    const features = await listFeaturesForLayer(DC, 'dl-1', 'main');
    expect(features).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/geojson'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/portal/items/dl-1/layers/main/delta?since=0&limit=1',
    );
  });

  it('with a cursor, applies delta upserts/deletes and advances syncVersion', async () => {
    await putDeployment(manifest(10));
    await putFeatures([
      {
        dataCollectionId: DC,
        dataLayerId: 'dl-1',
        layerKey: 'main',
        globalId: 'keep',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { _global_id: 'keep' },
        },
        cachedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        dataCollectionId: DC,
        dataLayerId: 'dl-1',
        layerKey: 'main',
        globalId: 'gone',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: { _global_id: 'gone' },
        },
        cachedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const page1: LayerDeltaResponse = {
      syncVersion: 15,
      since: 10,
      truncated: true,
      changes: [
        {
          observationId: 'o1',
          entity: 'new',
          kind: 'create',
          syncVersion: 11,
          geometry: { type: 'Point', coordinates: [2, 2] },
          properties: { name: 'new' },
        },
        {
          observationId: 'o2',
          entity: 'gone',
          kind: 'delete',
          syncVersion: 12,
          geometry: null,
          properties: null,
        },
      ],
    };
    const page2: LayerDeltaResponse = {
      syncVersion: 15,
      since: 12,
      truncated: false,
      changes: [
        {
          observationId: 'o3',
          entity: 'keep',
          kind: 'update',
          syncVersion: 15,
          geometry: { type: 'Point', coordinates: [9, 9] },
          properties: { name: 'updated' },
        },
      ],
    };

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('since=10')) return jsonResponse(page1);
      if (url.includes('since=12')) return jsonResponse(page2);
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadDeployment(
      {
        dataCollectionId: DC,
        title: 'Delta Test',
        mapId: 'map-1',
        layers: [LAYER],
        pickListIds: [],
      },
      () => {},
    );

    expect(result.layerSchemas['dl-1:main']?.syncVersion).toBe(15);
    const features = await listFeaturesForLayer(DC, 'dl-1', 'main');
    const ids = features
      .map((f) => (f.properties as { _global_id?: string })?._global_id)
      .sort();
    expect(ids).toEqual(['keep', 'new']);
    const keep = features.find(
      (f) => (f.properties as { _global_id?: string })?._global_id === 'keep',
    )!;
    expect(keep.geometry).toEqual({ type: 'Point', coordinates: [9, 9] });
    expect(keep.properties).toMatchObject({ name: 'updated' });
    // Never fell back to a full GeoJSON pull.
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('/geojson')))
      .toBe(true);
    const stored = await getDeployment(DC);
    expect(stored?.layerSchemas['dl-1:main']?.syncVersion).toBe(15);
  });
});
