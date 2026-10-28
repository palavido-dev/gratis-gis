// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildVerticesDerivedLayerCreatePayload,
  buildVerticesDerivedLayerData,
  defaultVerticesDerivedLayerTitle,
} from './analyze-vertices-derived';

describe('analyze-vertices-derived', () => {
  it('builds a single-step vertices recipe', () => {
    const data = buildVerticesDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([{ tool: 'vertices', params: {} }]);
  });

  it('defaults title and create payload', () => {
    expect(defaultVerticesDerivedLayerTitle('Parcels')).toBe(
      'Parcels · vertices',
    );
    const payload = buildVerticesDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · vertices');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('vertices');
    expect(payload.description).toMatch(/ST_DumpPoints/);
    expect(payload.description).toMatch(/vertex_index/);
    expect(payload.description).toMatch(/MULTI/);
  });
});
