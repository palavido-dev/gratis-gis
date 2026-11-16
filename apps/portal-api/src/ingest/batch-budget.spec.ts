// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  approxPropsBytes,
  BatchBudget,
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_ROWS,
} from './batch-budget.js';

function flushSizes(budget: BatchBudget, featureBytes: number[]): number[] {
  const sizes: number[] = [];
  let current = 0;
  for (const b of featureBytes) {
    current += 1;
    if (budget.add(b)) {
      sizes.push(current);
      current = 0;
      budget.reset();
    }
  }
  if (current > 0) sizes.push(current);
  return sizes;
}

describe('BatchBudget', () => {
  it('flushes small features on the row count, as before', () => {
    const budget = new BatchBudget();
    const sizes = flushSizes(budget, new Array(12_000).fill(200));
    expect(sizes).toEqual([DEFAULT_BATCH_ROWS, DEFAULT_BATCH_ROWS, 2_000]);
  });

  it('flushes large features on the byte budget (#573)', () => {
    // 5,000 polygons of 40 KB each is about 200 MB of GeoJSON in one
    // batch under the old rule.
    const budget = new BatchBudget();
    const sizes = flushSizes(budget, new Array(5_000).fill(40_000));
    const perBatch = Math.ceil(DEFAULT_BATCH_BYTES / 40_000);
    expect(sizes[0]).toBe(perBatch);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(Math.max(...sizes)).toBeLessThan(DEFAULT_BATCH_ROWS);
  });

  it('sends a single feature bigger than the budget on its own', () => {
    const budget = new BatchBudget(5_000, 1_000);
    expect(flushSizes(budget, [10, 5_000, 10])).toEqual([2, 1]);
  });

  it('ignores negative and non-finite sizes', () => {
    const budget = new BatchBudget(10, 100);
    expect(budget.add(Number.NaN)).toBe(false);
    expect(budget.add(-50)).toBe(false);
    expect(budget.add(Number.POSITIVE_INFINITY)).toBe(false);
    expect(budget.add(100)).toBe(true);
  });

  it('rejects a budget below one', () => {
    expect(() => new BatchBudget(0, 10)).toThrow(RangeError);
    expect(() => new BatchBudget(10, 0)).toThrow(RangeError);
  });
});

describe('approxPropsBytes', () => {
  it('grows with string length and key count', () => {
    const small = approxPropsBytes({ a: 'x' });
    const big = approxPropsBytes({ a: 'x'.repeat(1_000), b: 1, c: null });
    expect(big).toBeGreaterThan(small + 1_000);
  });

  it('handles an empty record', () => {
    expect(approxPropsBytes({})).toBe(2);
  });
});
