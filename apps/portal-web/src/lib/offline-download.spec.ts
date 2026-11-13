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
  enqueueEdit,
  getDeployment,
  listFeaturesForLayer,
  listQueueAllOwners,
  purgeCachedReadData,
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
    expect(buildDeltaUrl('dl-1', 'main', 4, 10, 'obs-9')).toBe(
      '/api/portal/items/dl-1/layers/main/delta?since=4&after=obs-9&limit=10',
    );
  });

  it('adds keyset paging to the GeoJSON pull', () => {
    const url = new URL(
      buildFeatureUrl('dl-1', 'sites', undefined, {
        limit: 5000,
        cursor: 'c-1',
        at: '2026-11-08T00:00:00.000Z',
      }),
      'https://example.test',
    );
    expect(url.searchParams.get('limit')).toBe('5000');
    expect(url.searchParams.get('cursor')).toBe('c-1');
    expect(url.searchParams.get('at')).toBe('2026-11-08T00:00:00.000Z');
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
    expect(b.feature.properties).toEqual({
      name: 'bee',
      _global_id: 'b',
      _observation_id: 'obs-b-update',
    });
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
      _observation_id: 'obs-x-create',
    });
  });

  it('keeps the conflict token and editor fields a full read carries', () => {
    const { upserts } = applyDeltaChanges(
      [
        change({
          entity: 'e',
          kind: 'update',
          observationId: 'head-2',
          authorSub: 'boss',
          txTime: '2026-11-08T10:00:00.000Z',
          createdBy: 'worker',
          createdAt: '2026-11-01T00:00:00.000Z',
        }),
      ],
      ctx,
    );
    expect(upserts[0]!.feature.properties).toMatchObject({
      _observation_id: 'head-2',
      _edited_by: 'boss',
      _edited_at: '2026-11-08T10:00:00.000Z',
      _created_by: 'worker',
      _created_at: '2026-11-01T00:00:00.000Z',
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

  it('full pull reads the head first, then pages the GeoJSON at one snapshot', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/geojson')) {
        const params = new URL(url, 'https://example.test').searchParams;
        // An install with GRATIS_FEATURE_QUERY_PAGE=required refuses
        // an unpaged read; the client must never send one.
        if (!params.get('limit')) return jsonResponse({ message: 'paging' }, 400);
        if (!params.get('cursor')) {
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
            nextCursor: 'f1',
            asOf: '2026-11-08T00:00:00.000Z',
          });
        }
        expect(params.get('cursor')).toBe('f1');
        expect(params.get('at')).toBe('2026-11-08T00:00:00.000Z');
        return jsonResponse({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'f2',
              geometry: { type: 'Point', coordinates: [1, 0] },
              properties: { _global_id: 'f2', name: 'two' },
            },
          ],
          nextCursor: null,
          asOf: '2026-11-08T00:00:00.000Z',
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
    expect(features).toHaveLength(2);
    // The head is read before the snapshot, so a write during the
    // download is newer than the stored cursor and arrives next time.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe('/api/portal/items/dl-1/layers/main/delta?since=0&limit=1');
    expect(urls.filter((u) => u.includes('/geojson'))).toHaveLength(2);
  });

  it('fails the layer when a page is the service worker cache fallback', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/delta?since=0&limit=1')) {
        return jsonResponse({ syncVersion: 42, since: 0, changes: [], truncated: false });
      }
      const params = new URL(url, 'https://example.test').searchParams;
      if (!params.get('cursor')) {
        return jsonResponse({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'f1',
              geometry: { type: 'Point', coordinates: [0, 0] },
              properties: { _global_id: 'f1' },
            },
          ],
          nextCursor: 'f1',
          asOf: '2026-11-08T00:00:00.000Z',
        });
      }
      // Signal dropped: the worker answered from an older cached copy.
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [], nextCursor: null }),
        { status: 200, headers: { 'x-gg-sw-fallback': '1' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadDeployment(
      { dataCollectionId: DC, title: 'Delta Test', mapId: 'map-1', layers: [LAYER], pickListIds: [] },
      () => {},
    );
    // Not recorded as complete, so the next download starts over
    // instead of syncing forward from a head it never reached.
    expect(result.layerSchemas['dl-1:main']?.syncVersion).toBeUndefined();
  });

  it('pages through one syncVersion that spans pages without skipping rows', async () => {
    await putDeployment(manifest(10));
    const row = (i: number) => ({
      observationId: `o${i}`,
      entity: `e${i}`,
      kind: 'create' as const,
      syncVersion: 11,
      geometry: { type: 'Point' as const, coordinates: [i, i] },
      properties: { i },
    });
    const pages: Record<string, LayerDeltaResponse> = {
      first: {
        syncVersion: 11,
        since: 10,
        truncated: true,
        changes: [row(1), row(2)],
        nextSince: 11,
        nextAfter: 'o2',
      },
      second: {
        syncVersion: 11,
        since: 11,
        truncated: false,
        changes: [row(3)],
      },
    };
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const params = new URL(String(input), 'https://example.test').searchParams;
      if (params.get('since') === '10' && !params.get('after')) return jsonResponse(pages.first);
      if (params.get('since') === '11' && params.get('after') === 'o2') {
        return jsonResponse(pages.second);
      }
      throw new Error(`unexpected fetch ${String(input)}`);
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
    expect(result.layerSchemas['dl-1:main']?.syncVersion).toBe(11);
    const features = await listFeaturesForLayer(DC, 'dl-1', 'main');
    expect(features).toHaveLength(3);
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

    // An older server: truncated with no nextSince / nextAfter. The
    // client re-reads the last version from its start (since=11).
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
      since: 11,
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
      if (url.includes('since=11')) return jsonResponse(page2);
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

describe('downloadDeployment: what a refresh can trust its cursor for', () => {
  // A small stand-in for the portal: features at site A and site B, a
  // head version, and changes since a version. GeoJSON reads honour
  // `bbox`, the delta read cannot (as on the real server).
  const DC = 'dc-area-1';
  const LAYER = {
    dataLayerId: 'dl-1',
    layerKey: 'main',
    layerLabel: 'Sites',
    fields: [] as import('@gratis-gis/shared-types').FeatureField[],
  };
  const SITE_A: [number, number, number, number] = [0, 0, 1, 1];
  const SITE_B: [number, number, number, number] = [10, 10, 11, 11];
  type Row = { id: string; x: number; y: number };
  let server: { rows: Row[]; head: number; changes: Array<{ v: number; row: Row }> };
  let fetchMock: jest.Mock;

  const feature = (r: Row) => ({
    type: 'Feature',
    id: r.id,
    geometry: { type: 'Point', coordinates: [r.x, r.y] },
    properties: { _global_id: r.id },
  });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    server = {
      rows: [
        { id: 'a1', x: 0.5, y: 0.5 },
        { id: 'a2', x: 0.6, y: 0.6 },
        { id: 'b1', x: 10.5, y: 10.5 },
      ],
      head: 800,
      changes: [],
    };
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://example.test');
      const q = url.searchParams;
      if (url.pathname.endsWith('/delta')) {
        const since = Number(q.get('since'));
        const changes = server.changes
          .filter((c) => c.v > since)
          .map((c) => ({
            observationId: `o${c.v}`,
            entity: c.row.id,
            kind: 'update',
            syncVersion: c.v,
            geometry: { type: 'Point', coordinates: [c.row.x, c.row.y] },
            properties: {},
          }));
        return json({ syncVersion: server.head, since, changes, truncated: false });
      }
      if (url.pathname.endsWith('/geojson')) {
        const b = (q.get('bbox') ?? '-180,-90,180,90').split(',').map(Number);
        const inside = server.rows.filter(
          (r) => r.x >= b[0]! && r.x <= b[2]! && r.y >= b[1]! && r.y <= b[3]!,
        );
        return json({ type: 'FeatureCollection', features: inside.map(feature), nextCursor: null });
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  const run = (bbox: [number, number, number, number] | undefined, signal?: AbortSignal) =>
    downloadDeployment(
      {
        dataCollectionId: DC,
        title: 'Area Test',
        mapId: 'map-1',
        layers: [LAYER],
        pickListIds: [],
        ...(bbox ? { bbox } : {}),
      },
      () => {},
      signal,
    );
  const cachedIds = async () =>
    (await listFeaturesForLayer(DC, 'dl-1', 'main')).map((f) => String(f.id)).sort();
  const geojsonCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('/geojson')).length;

  /** One queued edit, so every case can show the download never
   *  touches the write queue: nothing lost, nothing added. */
  async function queueOneEdit(): Promise<void> {
    await enqueueEdit({
      dataCollectionId: DC,
      op: 'update',
      dataLayerId: 'dl-1',
      layerKey: 'main',
      globalId: 'a1',
      geometry: null,
      properties: { name: 'fixed offline' },
      schemaHash: 'h',
      ownerUserId: 'u1',
    });
  }
  async function expectQueueIntact(): Promise<void> {
    const rows = await listQueueAllOwners(DC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      globalId: 'a1',
      syncStatus: 'pending',
      properties: { name: 'fixed offline' },
    });
  }

  it('does a full pull after sign-out emptied the features store (53-1)', async () => {
    await run(SITE_A);
    await queueOneEdit();
    await purgeCachedReadData();
    expect(await cachedIds()).toEqual([]);
    expect((await getDeployment(DC))!.layerSchemas['dl-1:main']!.syncVersion).toBeUndefined();

    server.changes.push({ v: 801, row: { id: 'a2', x: 0.61, y: 0.6 } });
    server.head = 801;
    fetchMock.mockClear();
    await run(SITE_A);

    expect(geojsonCalls()).toBe(1);
    expect(await cachedIds()).toEqual(['a1', 'a2']);
    await expectQueueIntact();
  });

  it('pulls the new area in full when the refresh is for somewhere else (53-2)', async () => {
    await run(SITE_A);
    await queueOneEdit();
    fetchMock.mockClear();

    await run(SITE_B);
    expect(geojsonCalls()).toBe(1);
    // Site B arrived and site A was kept.
    expect(await cachedIds()).toEqual(['a1', 'a2', 'b1']);
    const schema = (await getDeployment(DC))!.layerSchemas['dl-1:main']!;
    expect(schema.syncBbox).toEqual([0, 0, 11, 11]);

    // Back at site A: inside what is cached, so a delta is enough.
    fetchMock.mockClear();
    await run(SITE_A);
    expect(geojsonCalls()).toBe(0);
    await expectQueueIntact();
  });

  it('needs a full pull for the whole layer after an area download', async () => {
    await run(SITE_A);
    fetchMock.mockClear();
    await run(undefined);
    expect(geojsonCalls()).toBe(1);
    expect(await cachedIds()).toEqual(['a1', 'a2', 'b1']);
    expect((await getDeployment(DC))!.layerSchemas['dl-1:main']!.syncBbox).toBeNull();
  });

  it('does not store delta rows far outside the cached area', async () => {
    await run(SITE_A);
    server.changes.push(
      { v: 801, row: { id: 'far', x: 50, y: 50 } },
      { v: 802, row: { id: 'a1', x: 0.55, y: 0.5 } },
    );
    server.head = 802;
    await run(SITE_A);
    expect(await cachedIds()).toEqual(['a1', 'a2']);
  });

  it('keeps the cached size across an incremental refresh (53-4)', async () => {
    const first = await run(SITE_A);
    expect(first.estimatedSize).toBeGreaterThan(0);
    const second = await run(SITE_A);
    // Nothing changed on the server, and nothing left the device.
    expect(second.estimatedSize).toBeGreaterThanOrEqual(first.estimatedSize);
  });

  it('stops at the next request once cancelled (53-5)', async () => {
    const controller = new AbortController();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await base(input, init);
      // Cancel as soon as the first request of the run has answered.
      controller.abort();
      return res;
    });
    await queueOneEdit();
    await expect(
      downloadDeployment(
        {
          dataCollectionId: DC,
          title: 'Area Test',
          mapId: 'map-1',
          layers: [LAYER, { ...LAYER, layerKey: 'second' }],
          pickListIds: ['pl-1'],
          bbox: SITE_A,
        },
        () => {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getDeployment(DC)).toBeNull();
    await expectQueueIntact();
  });
});
