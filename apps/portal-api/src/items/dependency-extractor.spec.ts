// SPDX-License-Identifier: AGPL-3.0-or-later
import { extractDependencies } from './dependency-extractor.js';

describe('extractDependencies for derived_layer', () => {
  it('emits the source data layer as a hard forward edge', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: {
          kind: 'data_layer',
          itemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
        pipeline: [
          { tool: 'buffer', params: { distance: 100, unit: 'meters' } },
        ],
        featureLimit: 1000,
        outputSchema: [],
        bbox: [],
      },
    });
    expect(result.itemIds).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
    expect(result.urls).toEqual([]);
  });

  it('returns no edges when the source ref is missing', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: { version: 1, pipeline: [] },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('returns no edges when source.itemId is the empty string', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: '' },
        pipeline: [],
      },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });
});

describe('extractDependencies for map layer sources', () => {
  it('emits point-cloud and postgis-live item refs (#179 unit 3)', () => {
    const result = extractDependencies({
      type: 'map' as const,
      data: {
        version: 1,
        basemap: '',
        layers: [
          {
            id: 'l1',
            source: {
              kind: 'point-cloud',
              itemId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              dataUrl: '/api/portal/point-cloud/x/file.copc.laz',
            },
          },
          {
            id: 'l2',
            source: {
              kind: 'postgis-live',
              serviceItemId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
              tableName: 'public.parcels',
            },
          },
        ],
      },
    });
    expect(result.itemIds.sort()).toEqual([
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);
  });
});

describe('extractDependencies for custom web_app', () => {
  // Custom Web App items live as type='web_app' with
  // data.template='custom'. The dep walk must reach the app-level
  // mapId, every per-Map-widget mapId override, and every target's
  // dataLayerId so the cascade-on-public dialog (#310) doesn't
  // silently dismiss when the author makes a custom app public
  // that embeds private maps / private data_layers (the WV Parcel
  // Viewer symptom).
  const buildCustom = (custom: Record<string, unknown>) => ({
    type: 'web_app' as const,
    data: {
      template: 'custom',
      config: { template: 'custom', custom },
    },
  });

  it('emits the app-level mapId and every target dataLayerId', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        mapId: 'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm',
        targets: [
          {
            dataLayerId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            layerKey: 'layer-1',
          },
          {
            dataLayerId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            layerKey: 'layer-2',
          },
        ],
        pages: [],
      }),
    );
    expect([...result.itemIds].sort()).toEqual([
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm',
    ]);
    expect(result.urls).toEqual([]);
  });

  it('emits per-Map-widget mapId overrides across pages', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'map',
                config: {
                  kind: 'map',
                  mapId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                },
              },
              {
                id: 'w2',
                kind: 'text',
                config: { kind: 'text', markdown: '' },
              },
            ],
          },
          {
            id: 'second',
            title: 'Second',
            widgets: [
              {
                id: 'w3',
                kind: 'map',
                config: {
                  kind: 'map',
                  mapId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                },
              },
            ],
          },
        ],
      }),
    );
    expect([...result.itemIds].sort()).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
  });

  it('returns no edges for an empty custom app', () => {
    const result = extractDependencies(
      buildCustom({ version: 3, targets: [], pages: [] }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('emits file-item asset refs from image widgets', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  asset: {
                    kind: 'file-item',
                    itemId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    cachedUrl:
                      '/api/portal/storage/private/item-file/some-key',
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result.itemIds).toEqual([
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]);
  });

  it('skips external-url asset refs', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  asset: {
                    kind: 'external-url',
                    url: 'https://cdn.example.com/logo.png',
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('emits themePresetId only when it looks like a UUID', () => {
    // UUID-shape -> portal-item ref, must be in the dep graph.
    const uuidResult = extractDependencies(
      buildCustom({
        version: 3,
        themePresetId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        targets: [],
        pages: [],
      }),
    );
    expect(uuidResult.itemIds).toEqual([
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);

    // Starter-kind string -> in-process registry lookup, NOT an item.
    // Pass-through unchanged on emit.
    const starterResult = extractDependencies(
      buildCustom({
        version: 3,
        themePresetId: 'forest',
        targets: [],
        pages: [],
      }),
    );
    expect(starterResult.itemIds).toEqual([]);
  });

  it('emits print templateIds for Print widgets at any nesting depth', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'topbar',
                kind: 'container',
                config: {
                  kind: 'container',
                  position: 'sticky-top',
                  layout: 'row',
                  widgets: [
                    {
                      id: 'print-w',
                      kind: 'print',
                      config: {
                        kind: 'print',
                        mapWidgetId: 'm1',
                        templateIds: [
                          '11111111-1111-1111-1111-111111111111',
                          '22222222-2222-2222-2222-222222222222',
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    expect([...result.itemIds].sort()).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  it('skips legacy image widgets with only bare url', () => {
    // Legacy widgets pre-AssetRef have `url` but no `asset`. The
    // extractor can't recover an itemId from a URL synchronously,
    // so these are intentionally not crawled. Surfaced as a separate
    // future task: a one-off migration that backfills AssetRef from
    // any URL pointing at /api/portal/storage/private/item-file/...
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  url: '/api/portal/storage/private/item-file/some-key',
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });
});
