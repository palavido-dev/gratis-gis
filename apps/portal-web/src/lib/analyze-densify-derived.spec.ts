// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_DENSIFY_SEGMENT_METERS,
  MIN_DENSIFY_SEGMENT_METERS,
  buildDensifyDerivedLayerCreatePayload,
  buildDensifyDerivedLayerData,
  clampDensifySegmentLength,
  defaultDensifyDerivedLayerTitle,
  validateDensifySegmentLength,
} from './analyze-densify-derived';

describe('analyze-densify-derived', () => {
  it('builds a single-step densify recipe', () => {
    const data = buildDensifyDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      maxSegmentLength: 100,
      unit: 'meters',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'densify',
        params: { maxSegmentLength: 100, unit: 'meters' },
      },
    ]);
  });

  it('validates and clamps maxSegmentLength', () => {
    expect(validateDensifySegmentLength(0, 'meters')).toMatch(/greater/);
    expect(
      validateDensifySegmentLength(0.5, 'meters'),
    ).toMatch(/at least/);
    expect(validateDensifySegmentLength(10, 'meters')).toBeNull();
    expect(
      validateDensifySegmentLength(MAX_DENSIFY_SEGMENT_METERS + 1, 'meters'),
    ).toMatch(/at most/);
    expect(clampDensifySegmentLength(200_000, 'meters')).toBe(
      MAX_DENSIFY_SEGMENT_METERS,
    );
    expect(MIN_DENSIFY_SEGMENT_METERS).toBe(1);
  });

  it('defaults title and create payload', () => {
    expect(defaultDensifyDerivedLayerTitle('Roads', 100, 'meters')).toBe(
      'Roads · 100 m densify',
    );
    const payload = buildDensifyDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Roads',
      sourceItemId: 'src',
      layerKey: 'l1',
      maxSegmentLength: 50,
      unit: 'meters',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Roads · 50 m densify');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('densify');
    expect(payload.description).toMatch(/ST_Segmentize/);
  });
});
