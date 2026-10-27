// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildBufferDerivedLayerCreatePayload,
  buildFixedBufferDerivedLayerData,
  clampBufferDistance,
  defaultBufferDerivedLayerTitle,
  validateFixedBufferDistance,
} from './analyze-buffer-derived';

describe('clampBufferDistance', () => {
  it('returns 0 for non-positive or non-finite values', () => {
    expect(clampBufferDistance(0, 'meters')).toBe(0);
    expect(clampBufferDistance(-5, 'feet')).toBe(0);
    expect(clampBufferDistance(Number.NaN, 'meters')).toBe(0);
  });

  it('caps distances that exceed the shared soft max', () => {
    expect(clampBufferDistance(200_000, 'meters')).toBe(100_000);
    // 100 km in kilometers unit
    expect(clampBufferDistance(200, 'kilometers')).toBe(100);
  });
});

describe('validateFixedBufferDistance', () => {
  it('rejects empty / non-positive distances', () => {
    expect(validateFixedBufferDistance(0, 'meters')).toMatch(/greater than zero/i);
    expect(validateFixedBufferDistance(-1, 'feet')).toMatch(/greater than zero/i);
  });

  it('rejects distances above the soft max', () => {
    expect(validateFixedBufferDistance(100_001, 'meters')).toMatch(/at most/i);
  });

  it('accepts a normal guided distance', () => {
    expect(validateFixedBufferDistance(300, 'feet')).toBeNull();
    expect(validateFixedBufferDistance(100, 'meters')).toBeNull();
  });
});

describe('buildFixedBufferDerivedLayerData', () => {
  it('builds a single fixed buffer step against a data_layer source', () => {
    const data = buildFixedBufferDerivedLayerData({
      sourceItemId: 'dl-1',
      layerKey: 'layer-1',
      distance: 300,
      unit: 'feet',
    });
    expect(data.version).toBe(1);
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'dl-1',
      layerKey: 'layer-1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'buffer',
        params: { mode: 'fixed', distance: 300, unit: 'feet' },
      },
    ]);
    expect(data.featureLimit).toBe(1000);
    expect(data.outputSchema).toEqual([]);
    expect(data.bbox).toEqual([]);
  });

  it('omits layerKey when not provided', () => {
    const data = buildFixedBufferDerivedLayerData({
      sourceItemId: 'dl-2',
      distance: 100,
      unit: 'meters',
    });
    expect(data.source).toEqual({ kind: 'data_layer', itemId: 'dl-2' });
  });
});

describe('defaultBufferDerivedLayerTitle', () => {
  it('formats source label with distance and short unit', () => {
    expect(defaultBufferDerivedLayerTitle('Hydrants', 300, 'feet')).toBe(
      'Hydrants · 300 ft buffer',
    );
    expect(defaultBufferDerivedLayerTitle('  ', 100, 'meters')).toBe(
      'Layer · 100 m buffer',
    );
  });
});

describe('buildBufferDerivedLayerCreatePayload', () => {
  it('posts a private derived_layer with the guided recipe', () => {
    const payload = buildBufferDerivedLayerCreatePayload({
      title: 'Hydrants · 300 ft buffer',
      sourceLabel: 'Hydrants',
      sourceItemId: 'dl-1',
      layerKey: 'main',
      distance: 300,
      unit: 'feet',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.access).toBe('private');
    expect(payload.title).toBe('Hydrants · 300 ft buffer');
    expect(payload.description).toMatch(/Server-side buffer/);
    expect(payload.data.pipeline[0]).toEqual({
      tool: 'buffer',
      params: { mode: 'fixed', distance: 300, unit: 'feet' },
    });
  });

  it('falls back to the default title when the title is blank', () => {
    const payload = buildBufferDerivedLayerCreatePayload({
      title: '   ',
      sourceLabel: 'Roads',
      sourceItemId: 'dl-9',
      distance: 50,
      unit: 'meters',
    });
    expect(payload.title).toBe('Roads · 50 m buffer');
  });
});
