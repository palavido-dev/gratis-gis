// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildFishnetDerivedLayerCreatePayload,
  buildFishnetDerivedLayerData,
  clampFishnetCellSize,
  defaultFishnetDerivedLayerTitle,
  validateFishnetCellSize,
} from './analyze-fishnet-derived';

describe('analyze-fishnet-derived', () => {
  it('builds a single-step fishnet recipe', () => {
    const data = buildFishnetDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      cellSize: 500,
      unit: 'meters',
      output: 'polygons',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'fishnet',
        params: { cellSize: 500, unit: 'meters', output: 'polygons' },
      },
    ]);
  });

  it('validates and clamps cell size', () => {
    expect(validateFishnetCellSize(0, 'meters', 'polygons')).toMatch(
      /greater than zero/,
    );
    expect(validateFishnetCellSize(0.5, 'meters', 'polygons')).toMatch(
      /at least/,
    );
    expect(validateFishnetCellSize(500, 'meters', 'polygons')).toBeNull();
    expect(clampFishnetCellSize(999_999, 'meters')).toBe(100_000);
  });

  it('defaults title and create payload', () => {
    expect(
      defaultFishnetDerivedLayerTitle('City', 500, 'meters', 'polygons'),
    ).toBe('City · 500 m fishnet polygons');
    const payload = buildFishnetDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'City',
      sourceItemId: 'src',
      cellSize: 500,
      unit: 'meters',
      output: 'lines',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('City · 500 m fishnet lines');
    expect(payload.data.pipeline[0]?.tool).toBe('fishnet');
    expect(payload.description).toMatch(/ST_SquareGrid/);
  });
});
