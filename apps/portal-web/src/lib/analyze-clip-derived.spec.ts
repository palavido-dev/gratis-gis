// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildClipDerivedLayerCreatePayload,
  buildClipDerivedLayerData,
  defaultClipDerivedLayerTitle,
  validateClipOtherSource,
} from './analyze-clip-derived';

describe('validateClipOtherSource', () => {
  it('rejects an empty pick', () => {
    expect(validateClipOtherSource('', 'src-1')).toMatch(/Pick a clip layer/i);
  });

  it('rejects clipping a layer against itself', () => {
    expect(validateClipOtherSource('same', 'same')).toMatch(/different layer/i);
  });

  it('accepts a distinct clip layer id', () => {
    expect(validateClipOtherSource('clip-1', 'src-1')).toBeNull();
  });
});

describe('buildClipDerivedLayerData', () => {
  it('builds a single clip step against a second data_layer', () => {
    const data = buildClipDerivedLayerData({
      sourceItemId: 'dl-1',
      layerKey: 'layer-1',
      clipItemId: 'dl-2',
      clipLayerKey: 'zones',
    });
    expect(data.version).toBe(1);
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'dl-1',
      layerKey: 'layer-1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'clip',
        params: {
          otherSource: {
            kind: 'data_layer',
            itemId: 'dl-2',
            layerKey: 'zones',
          },
        },
      },
    ]);
    expect(data.featureLimit).toBe(1000);
  });

  it('omits optional layer keys when not provided', () => {
    const data = buildClipDerivedLayerData({
      sourceItemId: 'dl-1',
      clipItemId: 'dl-2',
    });
    expect(data.source).toEqual({ kind: 'data_layer', itemId: 'dl-1' });
    expect(data.pipeline[0]).toEqual({
      tool: 'clip',
      params: {
        otherSource: { kind: 'data_layer', itemId: 'dl-2' },
      },
    });
  });
});

describe('defaultClipDerivedLayerTitle', () => {
  it('formats source and clip labels', () => {
    expect(defaultClipDerivedLayerTitle('Hydrants', 'City boundary')).toBe(
      'Hydrants · clipped by City boundary',
    );
    expect(defaultClipDerivedLayerTitle('  ', '  ')).toBe(
      'Layer · clipped by clip layer',
    );
  });
});

describe('buildClipDerivedLayerCreatePayload', () => {
  it('posts a private derived_layer with the clip recipe', () => {
    const payload = buildClipDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Roads',
      clipLabel: 'County',
      sourceItemId: 'src',
      clipItemId: 'clip',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.access).toBe('private');
    expect(payload.title).toBe('Roads · clipped by County');
    expect(payload.data.pipeline[0]?.tool).toBe('clip');
  });
});
