// SPDX-License-Identifier: AGPL-3.0-or-later
import { looksLikeOpenGround } from './sam-outline';

/** A w x w mask with the given cells set. */
function mask(w: number, cells: Array<[number, number]>): Uint8Array {
  const m = new Uint8Array(w * w);
  for (const [x, y] of cells) m[y * w + x] = 1;
  return m;
}

describe('looksLikeOpenGround (54-9)', () => {
  const W = 64;

  it('accepts a small clicked component', () => {
    const building: Array<[number, number]> = [];
    for (let y = 20; y < 30; y += 1) for (let x = 20; x < 30; x += 1) building.push([x, y]);
    expect(looksLikeOpenGround(mask(W, building), W, W)).toBe(false);
  });

  it('rejects a component that fills the window', () => {
    const field: Array<[number, number]> = [];
    for (let y = 0; y < W; y += 1) for (let x = 0; x < W; x += 1) field.push([x, y]);
    expect(looksLikeOpenGround(mask(W, field), W, W)).toBe(true);
  });

  it('rejects a component that spans the window even when thin', () => {
    const cross: Array<[number, number]> = [];
    for (let i = 0; i < W; i += 1) cross.push([i, 32], [32, i]);
    expect(looksLikeOpenGround(mask(W, cross), W, W)).toBe(true);
  });
});
