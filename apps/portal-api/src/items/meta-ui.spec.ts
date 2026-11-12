// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildMetaUi, withMetaUi } from './meta-ui.js';
import { ItemsService } from './items.service.js';

describe('buildMetaUi', () => {
  it('emits one data-layer hint per v3 sublayer with geometry', () => {
    const ui = buildMetaUi({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'data_layer',
      title: 'Parcels',
      access: 'org',
      thumbnailUrl: null,
      data: {
        version: 3,
        layers: [
          { id: 'parcels', label: 'Parcels', geometryType: 'Polygon' },
          { id: 'notes', label: 'Notes', geometryType: null },
        ],
      },
    });
    expect(ui.version).toBe(1);
    expect(ui.landingPath).toBe(
      '/items/11111111-1111-4111-8111-111111111111',
    );
    expect(ui.layers).toHaveLength(1);
    expect(ui.layers[0]).toEqual({
      title: 'Parcels',
      source: {
        kind: 'data-layer',
        itemId: '11111111-1111-4111-8111-111111111111',
        layerKey: 'parcels',
      },
      geometryType: 'Polygon',
    });
    expect(ui.downloads).toEqual([
      {
        label: 'GeoJSON',
        // v3 is served per sublayer; the item-level route has no rows.
        url: '/api/items/11111111-1111-4111-8111-111111111111/layers/parcels/geojson',
        format: 'GeoJSON',
      },
    ]);
  });

  it('adds public OGC download only when access is public', () => {
    const ui = buildMetaUi({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'data_layer',
      title: 'Parcels',
      access: 'public',
      data: { version: 2 },
    });
    expect(ui.downloads.map((d) => d.url)).toEqual([
      '/api/items/11111111-1111-4111-8111-111111111111/geojson',
      '/api/public/ogc/collections/11111111-1111-4111-8111-111111111111/items?f=json',
    ]);
  });

  it('stamps point_cloud and arcgis_service layer sources', () => {
    const pc = buildMetaUi({
      id: '44444444-4444-4444-8444-444444444444',
      type: 'point_cloud',
      title: 'Lidar',
      data: {
        dataUrl: '/api/portal/point-cloud/44444444-4444-4444-8444-444444444444/file.copc.laz',
        hasRgb: true,
        pointCount: 1000,
      },
    });
    expect(pc.layers[0]?.source).toMatchObject({
      kind: 'point-cloud',
      colorScheme: 'rgb',
      pointCount: 1000,
    });
    expect(pc.downloads[0]?.format).toBe('COPC');

    const arc = buildMetaUi({
      id: '55555555-5555-4555-8555-555555555555',
      type: 'arcgis_service',
      title: 'AGO',
      data: {
        url: 'https://example.test/FeatureServer',
        serviceType: 'FeatureServer',
        defaultLayerId: 0,
        selectedLayerIds: [0],
        layers: [{ id: 0, name: 'Sites', geometryType: 'esriGeometryPoint' }],
      },
    });
    expect(arc.layers).toHaveLength(1);
    expect(arc.layers[0]?.source).toMatchObject({
      kind: 'arcgis-rest',
      layerId: 0,
      proxyUrl: '/api/portal/items/55555555-5555-4555-8555-555555555555/proxy',
    });
  });

  it('pins tile_layer URLs and skips DEM / vector packages', () => {
    const ui = buildMetaUi({
      id: '22222222-2222-4222-8222-222222222222',
      type: 'tile_layer',
      title: 'Ortho',
      thumbnailUrl: '/thumb.png',
      data: {
        tileUrl: '/api/portal/items/22222222-2222-4222-8222-222222222222/file',
        kind: 'raster',
        bbox: [-93, 44, -92, 45],
      },
    });
    expect(ui.layers[0]?.source).toMatchObject({
      kind: 'tile',
      tileUrl:
        '/api/portal/items/22222222-2222-4222-8222-222222222222/file.cog',
      bboxWgs84: [-93, 44, -92, 45],
    });
    expect(ui.thumbnailUrl).toBe('/thumb.png');

    expect(
      buildMetaUi({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'tile_layer',
        title: 'DEM',
        data: { tileUrl: '/x/file', dem: true },
      }).layers,
    ).toEqual([]);
  });

  it('withMetaUi stamps meta.ui without dropping other fields', () => {
    const row = withMetaUi({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'map',
      title: 'Campus',
      data: {},
      extra: true,
    });
    expect(row.extra).toBe(true);
    expect(row.meta.ui.layers).toEqual([]);
    expect(row.meta.ui.landingPath).toBe(
      '/items/33333333-3333-4333-8333-333333333333',
    );
  });
});


// A badly shaped data blob passes the save-time checks. The hints
// must not throw, or every later read, edit and delete of the item
// fails with a 500.
describe('buildMetaUi with a malformed blob', () => {
  const base = {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Broken',
    access: 'org',
    thumbnailUrl: null,
  };
  it.each([
    ['arcgis_service', { url: 'https://x/arcgis/rest/services/A/MapServer', layers: 5 }],
    ['arcgis_service', { url: 'https://x/arcgis/rest/services/A/MapServer', layers: [], selectedLayerIds: 5 }],
    ['tile_layer', { tileUrl: 5 }],
    ['data_layer', { version: 3, layers: [null] }],
  ])('returns empty hints for a %s blob it cannot read', (type, data) => {
    const ui = buildMetaUi({ ...base, type, data } as never);
    expect(ui.layers).toEqual([]);
    expect(ui.landingPath).toBe(`/items/${base.id}`);
  });
});

describe('filterMapForViewer with a malformed blob', () => {
  it('drops non-object layers and tolerates non-array access entries', async () => {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    Object.assign(svc, { prisma: { item: { findMany: async () => [] } } });
    const out = (await svc.filterMapForViewer(null, {
      layers: [
        null,
        { id: 'a', access: { policy: 'custom', entries: 5 } },
        { id: 'b' },
      ],
    })) as { layers: Array<{ id: string }> };
    expect(out.layers.map((l) => l.id)).toEqual(['b']);
  });
});

describe('filterMapForViewer backing items', () => {
  it('drops item-backed layers of every kind when the viewer cannot read the item', async () => {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    const findMany = jest.fn(async () => [
      { id: 'pub', access: 'public', shares: [] },
      { id: 'priv', access: 'private', shares: [] },
    ]);
    Object.assign(svc, { prisma: { item: { findMany } } });
    const out = (await svc.filterMapForViewer(null, {
      layers: [
        { id: 'a', source: { kind: 'arcgis-rest', url: 'https://x', sourceItemId: 'priv' } },
        { id: 'b', source: { kind: 'tile', itemId: 'priv' } },
        { id: 'c', source: { kind: 'point-cloud', itemId: 'priv' } },
        { id: 'd', source: { kind: 'postgis-live', serviceItemId: 'priv' } },
        { id: 'e', source: { kind: 'arcgis-rest', url: 'https://x', sourceItemId: 'pub' } },
        { id: 'f', source: { kind: 'arcgis-rest', url: 'https://x' } },
      ],
    })) as { layers: Array<{ id: string }> };
    expect(out.layers.map((l) => l.id)).toEqual(['e', 'f']);
    const asked = (findMany.mock.calls[0] as unknown as [{ where: { id: { in: string[] } } }])[0]
      .where.id.in;
    expect(asked.sort()).toEqual(['priv', 'pub']);
  });
});
