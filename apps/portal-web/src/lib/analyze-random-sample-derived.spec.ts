// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_RANDOM_SAMPLE_COUNT,
  buildRandomSampleDerivedLayerCreatePayload,
  buildRandomSampleDerivedLayerData,
  defaultRandomSampleDerivedLayerTitle,
  normalizeRandomSampleSeed,
  validateRandomSampleParams,
} from './analyze-random-sample-derived';

describe('analyze-random-sample-derived', () => {
  it('builds a random-sample recipe and normalizes seed', () => {
    expect(normalizeRandomSampleSeed(0)).toBe(1);
    expect(normalizeRandomSampleSeed(-42)).toBe(42);
    const data = buildRandomSampleDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      mode: 'percentage',
      value: 10,
      seed: 0,
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'random-sample',
        params: { mode: 'percentage', value: 10, seed: 1 },
      },
    ]);
  });

  it('validates mode / value / seed', () => {
    expect(validateRandomSampleParams('percentage', 0, 1)).toMatch(/positive/);
    expect(validateRandomSampleParams('percentage', 101, 1)).toMatch(
      /at most 100/,
    );
    expect(validateRandomSampleParams('count', 1.5, 1)).toMatch(/integer/);
    expect(
      validateRandomSampleParams('count', MAX_RANDOM_SAMPLE_COUNT + 1, 1),
    ).toMatch(/at most/);
    expect(validateRandomSampleParams('percentage', 10, 7)).toBeNull();
    expect(validateRandomSampleParams('count', 100, 7)).toBeNull();
  });

  it('defaults title and create payload', () => {
    expect(defaultRandomSampleDerivedLayerTitle('Parcels', 'percentage', 10)).toBe(
      'Parcels · random 10%',
    );
    expect(defaultRandomSampleDerivedLayerTitle('Parcels', 'count', 500)).toBe(
      'Parcels · random 500',
    );
    const payload = buildRandomSampleDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      mode: 'count',
      value: 50,
      seed: 99,
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · random 50');
    expect(payload.description).toMatch(/md5/);
    expect(payload.data.pipeline[0]).toEqual({
      tool: 'random-sample',
      params: { mode: 'count', value: 50, seed: 99 },
    });
  });
});
