// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Size-aware streaming knobs for maplibre-gl-lidar (#183).
 *
 * Every stream-update batch rebuilds the deck.gl layer dataset on the
 * main thread, so cost scales with the in-memory point budget. Until
 * the library appends/evicts per-node GPU resources (upstream + SSE
 * LOD), these tiers are the honest levers: fewer points per rebuild,
 * fewer rebuilds while the camera moves, fewer concurrent fetches, and
 * no picking buffers by default on huge clouds.
 *
 * Shared by the item viewer and the map overlay so both stay in sync.
 */

export type PointCloudStreamingTier = 'default' | 'huge' | 'ultra';

export interface PointCloudStreamingOptions {
  tier: PointCloudStreamingTier;
  streamingPointBudget: number;
  streamingViewportDebounceMs: number;
  streamingMaxConcurrentRequests: number;
  /**
   * Whether deck.gl picking should start on. The item viewer uses this
   * (panel can still toggle); map overlays keep picking off for UX
   * reasons regardless of tier.
   */
  pickable: boolean;
}

/** Clouds above this many points use the "huge" budget/debounce. */
export const HUGE_POINT_COUNT = 20_000_000;
/** Clouds above this many points use the stricter "ultra" tier. */
export const ULTRA_POINT_COUNT = 100_000_000;

/**
 * Resolve LidarControl streaming options from an item's point count.
 * Unknown / missing counts fall through to the snappy default tier.
 */
export function streamingOptionsForPointCount(
  pointCount: number | null | undefined,
): PointCloudStreamingOptions {
  const n = typeof pointCount === 'number' && Number.isFinite(pointCount)
    ? pointCount
    : 0;
  if (n > ULTRA_POINT_COUNT) {
    return {
      tier: 'ultra',
      streamingPointBudget: 750_000,
      streamingViewportDebounceMs: 600,
      streamingMaxConcurrentRequests: 2,
      pickable: false,
    };
  }
  if (n > HUGE_POINT_COUNT) {
    return {
      tier: 'huge',
      streamingPointBudget: 1_500_000,
      streamingViewportDebounceMs: 400,
      streamingMaxConcurrentRequests: 4,
      pickable: false,
    };
  }
  return {
    tier: 'default',
    streamingPointBudget: 4_000_000,
    streamingViewportDebounceMs: 150,
    streamingMaxConcurrentRequests: 4,
    pickable: true,
  };
}
