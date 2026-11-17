// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  editorTargetsExtent,
  isEditorTargetSublayer,
  serverSublayerOf,
  unionBbox,
} from './server-sublayer';
import { discoverLayerMetadata } from '@/app/items/[id]/map/layer-metadata';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ID2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const targetUrl = (id: string, key: string) =>
  `/api/portal/items/${id}/layers/${key}/geojson`;

describe('serverSublayerOf', () => {
  it('pages a v3 data-layer from the server', () => {
    expect(
      serverSublayerOf({
        id: 'l1',
        source: { kind: 'data-layer', itemId: ID, layerKey: 'parcels' },
      }),
    ).toEqual({ itemId: ID, layerKey: 'parcels' });
  });

  it('pages an Editor target from the server', () => {
    expect(
      serverSublayerOf({
        id: `editor-target:${ID}:parcels`,
        source: { kind: 'geojson-url', url: targetUrl(ID, 'parcels') },
      }),
    ).toEqual({ itemId: ID, layerKey: 'parcels' });
  });

  it('keeps other geojson-url layers client fed', () => {
    // Same URL, but not an Editor target: the map keys its rows by
    // position, so the table must keep reading the loaded collection.
    expect(
      serverSublayerOf({
        id: 'saved-layer',
        source: { kind: 'geojson-url', url: targetUrl(ID, 'parcels') },
      }),
    ).toBeNull();
    expect(
      serverSublayerOf({
        id: 'editor-target:x',
        source: { kind: 'geojson-url', url: 'https://example.com/a.geojson' },
      }),
    ).toBeNull();
  });

  it('refuses v1/v2 items and non-uuid ids', () => {
    expect(
      serverSublayerOf({ id: 'l', source: { kind: 'data-layer', itemId: ID } }),
    ).toBeNull();
    expect(
      serverSublayerOf({
        id: 'editor-target:x',
        source: { kind: 'geojson-url', url: targetUrl('..%2Fscripts', 'k') },
      }),
    ).toBeNull();
    expect(serverSublayerOf(null)).toBeNull();
  });

  it('still recognises a target whose url carries query params', () => {
    expect(
      isEditorTargetSublayer({
        id: `editor-target:${ID}:k`,
        source: { kind: 'geojson-url', url: `${targetUrl(ID, 'k')}?_ts=1` },
      }),
    ).toBe(true);
  });
});

describe('unionBbox', () => {
  it('spans every present box', () => {
    expect(
      unionBbox([
        [-118, 33, -117, 34],
        null,
        [-117.5, 32.5, -116, 33.5],
      ]),
    ).toEqual([-118, 32.5, -116, 34]);
  });

  it('is null when nothing usable is given', () => {
    expect(unionBbox([])).toBeNull();
    expect(unionBbox([null, undefined])).toBeNull();
    expect(unionBbox([[NaN, 0, 1, 1]])).toBeNull();
  });
});

describe('editorTargetsExtent', () => {
  it('unions the server extents of the Editor targets only', async () => {
    const asked: string[] = [];
    const extents: Record<string, [number, number, number, number] | null> = {
      [`/api/portal/items/${ID}/layers/a/filtered-extent`]: [-118, 33, -117, 34],
      [`/api/portal/items/${ID2}/layers/b/filtered-extent`]: [-116, 32, -115, 33],
    };
    const bbox = await editorTargetsExtent(
      [
        {
          id: `editor-target:${ID}:a`,
          source: { kind: 'geojson-url', url: targetUrl(ID, 'a') },
        },
        {
          id: `editor-target:${ID2}:b`,
          source: { kind: 'geojson-url', url: targetUrl(ID2, 'b') },
        },
        // A reference layer: not part of the fit.
        { id: 'ref', source: { kind: 'data-layer', itemId: ID, layerKey: 'z' } },
      ],
      async (url) => {
        asked.push(url);
        return extents[url] ?? null;
      },
    );
    expect(asked).toHaveLength(2);
    expect(bbox).toEqual([-118, 32, -115, 34]);
  });

  it('ignores a failed or empty target and asks nothing without targets', async () => {
    const bbox = await editorTargetsExtent(
      [
        {
          id: `editor-target:${ID}:a`,
          source: { kind: 'geojson-url', url: targetUrl(ID, 'a') },
        },
        {
          id: `editor-target:${ID2}:b`,
          source: { kind: 'geojson-url', url: targetUrl(ID2, 'b') },
        },
      ],
      async (url) => {
        if (url.includes(ID2)) throw new Error('offline');
        return [1, 2, 3, 4];
      },
    );
    expect(bbox).toEqual([1, 2, 3, 4]);
    const fetcher = jest.fn();
    expect(await editorTargetsExtent([], fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('discoverLayerMetadata for an Editor target', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reads the schema and never downloads the layer', async () => {
    const asked: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      return new Response(
        JSON.stringify({
          data: {
            version: 3,
            layers: [
              {
                id: 'parcels',
                geometryType: 'polygon',
                fields: [{ name: 'apn' }, { name: 'owner' }],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const md = await discoverLayerMetadata({
      id: `editor-target:${ID}:parcels`,
      source: { kind: 'geojson-url', url: targetUrl(ID, 'parcels') },
    } as Parameters<typeof discoverLayerMetadata>[0]);
    expect(asked).toEqual([`/api/portal/items/${ID}`]);
    expect(md.fields).toEqual(['apn', 'owner']);
    expect([...md.geometryTypes]).toEqual(['polygon']);
    expect(md.featureCollection).toBeNull();
  });
});
