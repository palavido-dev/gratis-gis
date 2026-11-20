// SPDX-License-Identifier: AGPL-3.0-or-later
import { HANDEDNESS_STORAGE_KEY, parseHandedness, readHandedness, writeHandedness } from './field-handedness';

describe('field handedness', () => {
  it('defaults to right for anything but "left"', () => {
    expect(parseHandedness('left')).toBe('left');
    expect(parseHandedness('right')).toBe('right');
    expect(parseHandedness(null)).toBe('right');
    expect(parseHandedness('LEFT')).toBe('right');
  });

  it('round-trips through storage', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    writeHandedness(storage, 'left');
    expect(map.get(HANDEDNESS_STORAGE_KEY)).toBe('left');
    expect(readHandedness(storage)).toBe('left');
  });

  it('survives storage that throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readHandedness(throwing)).toBe('right');
    expect(() => writeHandedness(throwing, 'left')).not.toThrow();
    expect(readHandedness(undefined)).toBe('right');
  });
});
