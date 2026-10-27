// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HUGE_POINT_COUNT,
  ULTRA_POINT_COUNT,
  streamingOptionsForPointCount,
} from './point-cloud-streaming';

describe('streamingOptionsForPointCount', () => {
  it('uses the default tier for small and missing counts', () => {
    expect(streamingOptionsForPointCount(undefined).tier).toBe('default');
    expect(streamingOptionsForPointCount(null).tier).toBe('default');
    expect(streamingOptionsForPointCount(0).tier).toBe('default');
    expect(streamingOptionsForPointCount(HUGE_POINT_COUNT).tier).toBe(
      'default',
    );
    expect(streamingOptionsForPointCount(1_000_000)).toMatchObject({
      streamingPointBudget: 4_000_000,
      streamingViewportDebounceMs: 150,
      streamingMaxConcurrentRequests: 4,
      pickable: true,
    });
  });

  it('uses the huge tier above 20M points', () => {
    expect(streamingOptionsForPointCount(HUGE_POINT_COUNT + 1)).toMatchObject({
      tier: 'huge',
      streamingPointBudget: 1_500_000,
      streamingViewportDebounceMs: 400,
      streamingMaxConcurrentRequests: 4,
      pickable: false,
    });
    expect(streamingOptionsForPointCount(ULTRA_POINT_COUNT).tier).toBe('huge');
  });

  it('uses the ultra tier above 100M points', () => {
    expect(streamingOptionsForPointCount(ULTRA_POINT_COUNT + 1)).toMatchObject({
      tier: 'ultra',
      streamingPointBudget: 750_000,
      streamingViewportDebounceMs: 600,
      streamingMaxConcurrentRequests: 2,
      pickable: false,
    });
    expect(streamingOptionsForPointCount(209_000_000).tier).toBe('ultra');
  });
});
