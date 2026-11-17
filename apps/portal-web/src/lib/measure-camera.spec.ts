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
  it('jumps to pitch 0, locks maxPitch, and restores both on cleanup', () => {
    const jumps: Array<{ pitch: number }> = [];
    const eases: Array<{ pitch: number; duration?: number }> = [];
    const maxPitches: number[] = [];
    const map = {
      getPitch: () => 48,
      getMaxPitch: () => 85,
      setMaxPitch: (p: number) => {
        maxPitches.push(p);
      },
      jumpTo: (opts: { pitch: number }) => {
        jumps.push(opts);
      },
      easeTo: (opts: { pitch: number; duration?: number }) => {
        eases.push(opts);
      },
    };
    const restore = flattenPitchForMeasure(map);
    expect(jumps).toEqual([{ pitch: 0 }]);
    expect(maxPitches).toEqual([0]);
    expect(eases).toEqual([]);
    restore();
    expect(maxPitches).toEqual([0, 85]);
    expect(eases).toEqual([{ pitch: 48, duration: 280 }]);
  });

  it('locks maxPitch even when already flat', () => {
    const maxPitches: number[] = [];
    const jumps: unknown[] = [];
    const restore = flattenPitchForMeasure({
      getPitch: () => 0,
      getMaxPitch: () => 85,
      setMaxPitch: (p) => maxPitches.push(p),
      jumpTo: (opts) => jumps.push(opts),
    });
    expect(jumps).toEqual([]);
    expect(maxPitches).toEqual([0]);
    restore();
    expect(maxPitches).toEqual([0, 85]);
  });

  it('falls back to setPitch when jumpTo is missing', () => {
    const pitches: number[] = [];
    const map = {
      getPitch: () => 60,
      setPitch: (pitch: number) => {
        pitches.push(pitch);
      },
    };
    const restore = flattenPitchForMeasure(map);
    expect(pitches).toEqual([0]);
    restore();
    expect(pitches).toEqual([0, 60]);
  });

  it('is a no-op when already flat and maxPitch unlocked', () => {
    const jumps: unknown[] = [];
    const restore = flattenPitchForMeasure({
      getPitch: () => 0,
      getMaxPitch: () => 0,
      setMaxPitch: () => undefined,
      jumpTo: (opts) => jumps.push(opts),
    });
    expect(jumps).toEqual([]);
    restore();
    expect(jumps).toEqual([]);
  });
});
