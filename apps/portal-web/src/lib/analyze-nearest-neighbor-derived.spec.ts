// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildNearestNeighborDerivedLayerCreatePayload,
  buildNearestNeighborDerivedLayerData,
  defaultNearestNeighborDerivedLayerTitle,
} from './analyze-nearest-neighbor-derived';

describe('analyze-nearest-neighbor-derived', () => {
  it('builds a single-step nearest-neighbor recipe', () => {
    const data = buildNearestNeighborDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      { tool: 'nearest-neighbor', params: {} },
    ]);
  });

  it('defaults title and create payload', () => {
    expect(defaultNearestNeighborDerivedLayerTitle('Wells')).toBe(
      'Wells · nearest neighbor',
    );
    expect(defaultNearestNeighborDerivedLayerTitle('  ')).toBe(
      'Layer · nearest neighbor',
    );
    const payload = buildNearestNeighborDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Wells',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Wells · nearest neighbor');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('nearest-neighbor');
    expect(payload.description).toMatch(/nearest_distance_m/);
    expect(payload.description).toMatch(/O\(N²\)/);
  });
});
