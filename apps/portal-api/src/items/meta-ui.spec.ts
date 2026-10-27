// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildMetaUi, withMetaUi } from './meta-ui.js';

describe('buildMetaUi', () => {
  it('emits one data-layer hint per v3 sublayer with geometry', () => {
    const ui = buildMetaUi({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'data_layer',
      title: 'Parcels',
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
    expect(ui.downloads[0]?.format).toBe('GeoJSON');
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

