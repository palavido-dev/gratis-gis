// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildEraseDerivedLayerCreatePayload,
  buildEraseDerivedLayerData,
  defaultEraseDerivedLayerTitle,
  validateEraseOtherSource,
} from './analyze-erase-derived';

describe('analyze-erase-derived', () => {
  it('rejects empty or self mask picks', () => {
    expect(validateEraseOtherSource('', 'src')).toMatch(/Pick an erase mask/);
    expect(validateEraseOtherSource('src', 'src')).toMatch(/different layer/);
    expect(validateEraseOtherSource('mask', 'src')).toBeNull();
  });

  it('builds a single-step erase recipe', () => {
    const data = buildEraseDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      eraseItemId: 'mask',
      eraseLayerKey: 'm1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'erase',
        params: {
          otherSource: {
            kind: 'data_layer',
            itemId: 'mask',
            layerKey: 'm1',
          },
        },
      },
    ]);
  });

  it('defaults title and create payload', () => {
    expect(defaultEraseDerivedLayerTitle('Parcels', 'Flood')).toBe(
      'Parcels · erased by Flood',
    );
    const payload = buildEraseDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      eraseLabel: 'Flood',
      sourceItemId: 'src',
      eraseItemId: 'mask',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · erased by Flood');
    expect(payload.data.pipeline[0]?.tool).toBe('erase');
  });
});
