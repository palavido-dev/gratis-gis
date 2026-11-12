// SPDX-License-Identifier: AGPL-3.0-or-later
import { clampDigits, formatAggregateValue } from './layer-aggregate';

describe('formatAggregateValue with out-of-range decimals', () => {
  it('does not throw for negative or huge decimal places', () => {
    expect(formatAggregateValue(1.5, { decimals: -1 })).toBe('2');
    expect(() => formatAggregateValue(1.5, { decimals: 200 })).not.toThrow();
    expect(() => formatAggregateValue(1.5, { decimals: -3, compact: true })).not.toThrow();
  });
  it('clamps digit counts', () => {
    expect(clampDigits(-1)).toBe(0);
    expect(clampDigits(3.7)).toBe(3);
    expect(clampDigits(99)).toBe(20);
    expect(clampDigits(Number.NaN)).toBe(0);
  });
});
