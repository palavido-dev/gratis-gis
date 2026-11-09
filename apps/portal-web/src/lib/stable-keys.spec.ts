// SPDX-License-Identifier: AGPL-3.0-or-later
import { StableKeys } from './stable-keys';

describe('StableKeys', () => {
  it('moves keys with their rows', () => {
    const k = new StableKeys();
    const [a, b, c] = k.for(3);
    k.remove(0);
    expect(k.for(2)).toEqual([b, c]);
    k.insert(1);
    const after = k.for(3);
    expect(after[0]).toBe(b);
    expect(after[2]).toBe(c);
    expect(new Set([a, ...after]).size).toBe(4);
  });

  it('pads and trims for outside changes', () => {
    const k = new StableKeys();
    expect(k.for(2)).toHaveLength(2);
    expect(k.for(0)).toHaveLength(0);
  });
});
