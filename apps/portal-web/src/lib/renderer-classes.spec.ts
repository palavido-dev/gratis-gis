// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  normalizeClassBreaks,
  resampleColors,
  resizeStops,
  uniqueCategories,
} from './renderer-classes';

describe('resizeStops', () => {
  it('grows strictly ascending instead of repeating the last stop', () => {
    expect(resizeStops([33, 66, 100], 4)).toEqual([33, 66, 100, 134]);
    expect(resizeStops([5], 3)).toEqual([5, 6, 7]);
    expect(resizeStops([], 2)).toEqual([1, 2]);
  });
  it('shrinks by keeping the first stops', () => {
    expect(resizeStops([1, 2, 3], 2)).toEqual([1, 2]);
  });
});

describe('normalizeClassBreaks', () => {
  it('sorts stops and carries each colour along', () => {
    expect(normalizeClassBreaks([50, 10], ['#000000', '#aa0000', '#00aa00'])).toEqual({
      stops: [10, 50],
      colors: ['#000000', '#00aa00', '#aa0000'],
    });
  });
  it('drops a repeated stop', () => {
    expect(normalizeClassBreaks([33, 66, 100, 100], ['a', 'b', 'c', 'd', 'e'])).toEqual({
      stops: [33, 66, 100],
      colors: ['a', 'b', 'c', 'd'],
    });
  });
  it('refuses a colour count that does not fit', () => {
    expect(normalizeClassBreaks([1, 2], ['a', 'b'])).toBeNull();
  });
});

describe('uniqueCategories', () => {
  it('keeps the first of each value', () => {
    const out = uniqueCategories([
      { value: '', color: 'a' },
      { value: '', color: 'b' },
      { value: 'x', color: 'c' },
    ]);
    expect(out).toEqual([
      { value: '', color: 'a' },
      { value: 'x', color: 'c' },
    ]);
  });
});

describe('resampleColors', () => {
  it('stretches a ramp and keeps its ends', () => {
    const out = resampleColors(['#000000', '#ffffff'], 3);
    expect(out).toEqual(['#000000', '#808080', '#ffffff']);
  });
});
