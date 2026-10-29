// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  flattenPitchForMeasure,
  shouldFlattenPitchForMeasure,
} from './measure-camera';

describe('shouldFlattenPitchForMeasure', () => {
  it('is false for flat and near-flat cameras', () => {
    expect(shouldFlattenPitchForMeasure(0)).toBe(false);
    expect(shouldFlattenPitchForMeasure(1.5)).toBe(false);
  });

  it('is true for pitched 3D views', () => {
    expect(shouldFlattenPitchForMeasure(45)).toBe(true);
    expect(shouldFlattenPitchForMeasure(2.1)).toBe(true);
  });
});

describe('flattenPitchForMeasure', () => {
  it('eases to pitch 0 and restores on cleanup', () => {
    const calls: Array<{ pitch: number; duration?: number }> = [];
    const map = {
      getPitch: () => 48,
      easeTo: (opts: { pitch: number; duration?: number }) => {
        calls.push(opts);
      },
    };
    const restore = flattenPitchForMeasure(map);
    expect(calls).toEqual([{ pitch: 0, duration: 280 }]);
    restore();
    expect(calls).toEqual([
      { pitch: 0, duration: 280 },
      { pitch: 48, duration: 280 },
    ]);
  });

  it('is a no-op when already flat', () => {
    const calls: unknown[] = [];
    const restore = flattenPitchForMeasure({
      getPitch: () => 0,
      easeTo: (opts) => calls.push(opts),
    });
    expect(calls).toEqual([]);
    restore();
    expect(calls).toEqual([]);
  });
});
