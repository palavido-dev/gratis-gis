// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildCentroidDerivedLayerCreatePayload,
  buildCentroidDerivedLayerData,
  defaultCentroidDerivedLayerTitle,
} from './analyze-centroid-derived';

describe('analyze-centroid-derived', () => {
  it('builds a single-step centroid recipe', () => {
    const data = buildCentroidDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([{ tool: 'centroid', params: {} }]);
  });

  it('defaults title and create payload', () => {
    expect(defaultCentroidDerivedLayerTitle('Parcels')).toBe(
      'Parcels · centroids',
    );
    expect(defaultCentroidDerivedLayerTitle('  ')).toBe('Layer · centroids');
    const payload = buildCentroidDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · centroids');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('centroid');
    expect(payload.description).toMatch(/ST_Centroid/);
  });
});
