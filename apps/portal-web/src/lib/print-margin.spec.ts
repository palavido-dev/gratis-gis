// SPDX-License-Identifier: AGPL-3.0-or-later
import { clampPrintMarginIn, maxPrintMarginIn } from './print-margin';

describe('clampPrintMarginIn', () => {
  const letter = { w: 8.5, h: 11 };

  it('keeps a usable margin as typed', () => {
    expect(clampPrintMarginIn(0, letter)).toBe(0);
    expect(clampPrintMarginIn(0.5, letter)).toBe(0.5);
  });

  it('raises a negative margin to zero', () => {
    expect(clampPrintMarginIn(-2, letter)).toBe(0);
  });

  it('lowers a margin wider than a quarter of the shorter side', () => {
    expect(maxPrintMarginIn(letter)).toBe(2.125);
    expect(clampPrintMarginIn(40, letter)).toBe(2.125);
    expect(clampPrintMarginIn(40, { w: 11, h: 8.5 })).toBe(2.125);
  });

  it('gives zero for a value that is not a number, as the field did', () => {
    expect(clampPrintMarginIn(Number.NaN, letter)).toBe(0);
    expect(clampPrintMarginIn(Number.POSITIVE_INFINITY, letter)).toBe(0);
  });
});
