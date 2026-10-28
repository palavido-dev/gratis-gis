// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_SIMPLIFY_TOLERANCE_METERS,
  buildSimplifyDerivedLayerCreatePayload,
  buildSimplifyDerivedLayerData,
  clampSimplifyTolerance,
  defaultSimplifyDerivedLayerTitle,
  validateSimplifyTolerance,
} from './analyze-simplify-derived';

describe('analyze-simplify-derived', () => {
  it('builds a single-step simplify recipe', () => {
    const data = buildSimplifyDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      tolerance: 10,
      unit: 'meters',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      { tool: 'simplify', params: { tolerance: 10, unit: 'meters' } },
    ]);
  });

  it('validates and clamps tolerance', () => {
    expect(validateSimplifyTolerance(0, 'meters')).toMatch(/greater/);
    expect(validateSimplifyTolerance(10, 'meters')).toBeNull();
    expect(
      validateSimplifyTolerance(MAX_SIMPLIFY_TOLERANCE_METERS + 1, 'meters'),
    ).toMatch(/at most/);
    expect(clampSimplifyTolerance(200_000, 'meters')).toBe(
      MAX_SIMPLIFY_TOLERANCE_METERS,
    );
  });

  it('defaults title and create payload', () => {
    expect(defaultSimplifyDerivedLayerTitle('Parcels', 10, 'meters')).toBe(
      'Parcels · 10 m simplify',
    );
    const payload = buildSimplifyDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
      tolerance: 5,
      unit: 'meters',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · 5 m simplify');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('simplify');
    expect(payload.description).toMatch(/ST_Simplify/);
  });
});
