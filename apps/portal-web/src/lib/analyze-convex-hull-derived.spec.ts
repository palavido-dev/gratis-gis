// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildConvexHullDerivedLayerCreatePayload,
  buildConvexHullDerivedLayerData,
  defaultConvexHullDerivedLayerTitle,
} from './analyze-convex-hull-derived';

describe('analyze-convex-hull-derived', () => {
  it('builds a single-step convex-hull recipe', () => {
    const data = buildConvexHullDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([{ tool: 'convex-hull', params: {} }]);
  });

  it('defaults title and create payload', () => {
    expect(defaultConvexHullDerivedLayerTitle('Parcels')).toBe(
      'Parcels · convex hulls',
    );
    expect(defaultConvexHullDerivedLayerTitle('  ')).toBe(
      'Layer · convex hulls',
    );
    const payload = buildConvexHullDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      layerKey: 'l1',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · convex hulls');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('convex-hull');
    expect(payload.description).toMatch(/ST_ConvexHull/);
    expect(payload.description).toMatch(/Not one hull/);
  });
});
