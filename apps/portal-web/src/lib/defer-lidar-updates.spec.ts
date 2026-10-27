// SPDX-License-Identifier: AGPL-3.0-or-later
import { deferLidarUpdatesWhileMoving } from './defer-lidar-updates';

type Handler = () => void;

function makeFakeMap(initiallyMoving = false) {
  const handlers = new Map<string, Set<Handler>>();
  let moving = initiallyMoving;
  let zooming = false;
  return {
    isMoving: () => moving,
    isZooming: () => zooming,
    setMoving(v: boolean) {
      moving = v;
    },
    setZooming(v: boolean) {
      zooming = v;
    },
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string) {
      for (const h of handlers.get(event) ?? []) h();
    },
  };
}

describe('deferLidarUpdatesWhileMoving', () => {
  it('no-ops when the control has no manager', () => {
    const map = makeFakeMap();
    const stop = deferLidarUpdatesWhileMoving(
      map as never,
      {} as never,
    );
    expect(() => stop()).not.toThrow();
  });

  it('passes updates through when the camera is idle', () => {
    const map = makeFakeMap(false);
    const updatePointCloud = jest.fn();
    const control = { _pointCloudManager: { updatePointCloud } };
    deferLidarUpdatesWhileMoving(map as never, control as never);
    control._pointCloudManager.updatePointCloud('a', { pointCount: 1 });
    expect(updatePointCloud).toHaveBeenCalledTimes(1);
  });

  it('coalesces updates during a move and flushes on moveend', () => {
    const map = makeFakeMap(false);
    const updatePointCloud = jest.fn();
    const control = { _pointCloudManager: { updatePointCloud } };
    deferLidarUpdatesWhileMoving(map as never, control as never);

    map.emit('movestart');
    control._pointCloudManager.updatePointCloud('a', { pointCount: 1 });
    control._pointCloudManager.updatePointCloud('a', { pointCount: 2 });
    control._pointCloudManager.updatePointCloud('b', { pointCount: 3 });
    expect(updatePointCloud).not.toHaveBeenCalled();

    map.emit('moveend');
    expect(updatePointCloud).toHaveBeenCalledTimes(2);
    expect(updatePointCloud).toHaveBeenCalledWith('a', { pointCount: 2 });
    expect(updatePointCloud).toHaveBeenCalledWith('b', { pointCount: 3 });
  });

  it('restores the original method on teardown', () => {
    const map = makeFakeMap(false);
    const updatePointCloud = jest.fn();
    const mgr = { updatePointCloud };
    const control = { _pointCloudManager: mgr };
    const stop = deferLidarUpdatesWhileMoving(map as never, control as never);
    stop();
    expect(mgr.updatePointCloud).toBe(updatePointCloud);
  });
});
