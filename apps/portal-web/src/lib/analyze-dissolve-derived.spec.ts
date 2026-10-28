// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildDissolveDerivedLayerCreatePayload,
  buildDissolveDerivedLayerData,
  defaultDissolveDerivedLayerTitle,
} from './analyze-dissolve-derived';

describe('analyze-dissolve-derived', () => {
  it('builds a single-step dissolve recipe', () => {
    const data = buildDissolveDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([{ tool: 'dissolve', params: {} }]);
  });

  it('defaults title and create payload', () => {
    expect(defaultDissolveDerivedLayerTitle('Parcels')).toBe(
      'Parcels · dissolve',
    );
    expect(defaultDissolveDerivedLayerTitle('  ')).toBe('Layer · dissolve');
    const payload = buildDissolveDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · dissolve');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('dissolve');
    expect(payload.description).toMatch(/ST_Union/);
    expect(payload.description).toMatch(/attributes dropped/i);
  });
});
