// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Defer maplibre-gl-lidar deck.gl rebuilds while the camera moves (#183).
 *
 * The library's streaming path calls PointCloudManager.updatePointCloud on
 * every batched node load, and that rebuilds the full in-memory point set
 * into fresh PointCloudLayer chunks on the main thread. Applying those
 * rebuilds mid-pan is what measured as multi-second stalls on ~200M-point
 * COPCs. Holding updates until move/zoom settle keeps streaming I/O warm
 * while cutting interactive jank to a single flush.
 *
 * This reaches into LidarControl's private manager (not part of the public
 * API). If a library bump renames the field, the helper no-ops and the
 * size-aware streaming tiers remain the fallback.
 */
import type * as maplibregl from 'maplibre-gl';
import type { LidarControl } from 'maplibre-gl-lidar';

interface PointCloudManagerLike {
  updatePointCloud: (id: string, data: unknown) => void;
}

interface LidarControlInternals {
  _pointCloudManager?: PointCloudManagerLike;
}

export function deferLidarUpdatesWhileMoving(
  map: maplibregl.Map,
  control: LidarControl,
): () => void {
  const mgr = (control as unknown as LidarControlInternals)._pointCloudManager;
  if (!mgr || typeof mgr.updatePointCloud !== 'function') {
    return () => undefined;
  }

  const original = mgr.updatePointCloud;
  let moving = map.isMoving() || map.isZooming();
  const pending = new Map<string, unknown>();

  const apply = (id: string, data: unknown) => {
    original.call(mgr, id, data);
  };

  mgr.updatePointCloud = (id: string, data: unknown) => {
    if (moving || map.isMoving() || map.isZooming()) {
      pending.set(id, data);
      return;
    }
    apply(id, data);
  };

  const onStart = () => {
    moving = true;
  };
  const onEnd = () => {
    moving = false;
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [id, data] of batch) {
      apply(id, data);
    }
  };

  map.on('movestart', onStart);
  map.on('zoomstart', onStart);
  map.on('moveend', onEnd);
  map.on('zoomend', onEnd);

  return () => {
    map.off('movestart', onStart);
    map.off('zoomstart', onStart);
    map.off('moveend', onEnd);
    map.off('zoomend', onEnd);
    mgr.updatePointCloud = original;
    pending.clear();
  };
}
