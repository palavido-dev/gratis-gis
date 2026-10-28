// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildBboxDerivedLayerCreatePayload,
  buildBboxDerivedLayerData,
  defaultBboxDerivedLayerTitle,
} from './analyze-bbox-derived';

describe('analyze-bbox-derived', () => {
  it('builds a single-step bbox recipe', () => {
    const data = buildBboxDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([{ tool: 'bbox', params: {} }]);
  });

  it('defaults title and create payload', () => {
    expect(defaultBboxDerivedLayerTitle('Parcels')).toBe(
      'Parcels · bounding boxes',
    );
    expect(defaultBboxDerivedLayerTitle('  ')).toBe(
      'Layer · bounding boxes',
    );
    const payload = buildBboxDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · bounding boxes');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('bbox');
    expect(payload.description).toMatch(/ST_Envelope/);
    expect(payload.description).toMatch(/Not one envelope/);
  });
});
