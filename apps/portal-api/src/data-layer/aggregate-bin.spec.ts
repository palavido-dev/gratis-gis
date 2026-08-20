// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_BINS,
  parseAggregateQuery,
  parseBin,
  rejectUnknownAggregateParams,
} from './aggregate-params.js';
import {
  binRangeFor,
  resolveBinEdges,
  type AggregateBin,
} from '../engine/data-layer.js';

/**
 * #27: binning turns a chart into a distribution. The tests worth
 * having are the ones where a permissive parser or a sloppy edge
 * calculation would produce a chart that LOOKS right: a histogram
 * whose tails were silently dropped, or whose bars do not add up to
 * the layer, is worse than an error, because nothing on screen says
 * so.
 */

describe('parseBin', () => {
  it('reads the three modes', () => {
    expect(parseBin('{"field":"iron","mode":"count","count":20}')).toEqual({
      field: 'iron',
      mode: 'count',
      count: 20,
    });
    expect(parseBin('{"field":"iron","mode":"width","width":0.5}')).toEqual({
      field: 'iron',
      mode: 'width',
      width: 0.5,
    });
    expect(
      parseBin('{"field":"iron","mode":"edges","edges":[0.3,1,5]}'),
    ).toEqual({ field: 'iron', mode: 'edges', edges: [0.3, 1, 5] });
  });

  it('is absent when unset', () => {
    expect(parseBin(undefined)).toBeUndefined();
    expect(parseBin('')).toBeUndefined();
  });

  it('refuses a mode it does not implement', () => {
    expect(() =>
      parseBin('{"field":"iron","mode":"quantile","count":4}'),
    ).toThrow(/bin.mode must be/);
  });

  it('refuses a bin count outside the drawable range', () => {
    expect(() => parseBin('{"field":"x","mode":"count","count":1}')).toThrow(
      /between 2 and/,
    );
    expect(() =>
      parseBin(`{"field":"x","mode":"count","count":${MAX_BINS + 1}}`),
    ).toThrow(/between 2 and/);
  });

  it('refuses a non-positive width', () => {
    expect(() => parseBin('{"field":"x","mode":"width","width":0}')).toThrow(
      /positive number/,
    );
    expect(() => parseBin('{"field":"x","mode":"width","width":-2}')).toThrow(
      /positive number/,
    );
  });

  // Descending or duplicated thresholds are refused rather than
  // sorted: width_bucket raises on a duplicate, and quietly sorting a
  // caller's list would relabel their buckets while they believed
  // their class breaks had been honoured.
  it('refuses edges that are not strictly ascending', () => {
    expect(() =>
      parseBin('{"field":"x","mode":"edges","edges":[5,1]}'),
    ).toThrow(/strictly ascending/);
    expect(() =>
      parseBin('{"field":"x","mode":"edges","edges":[1,1]}'),
    ).toThrow(/strictly ascending/);
  });

  it('refuses a non-finite edge', () => {
    expect(() =>
      parseBin('{"field":"x","mode":"edges","edges":[1,"abc"]}'),
    ).toThrow(/finite number/);
  });

  it('refuses a missing field', () => {
    expect(() => parseBin('{"mode":"count","count":10}')).toThrow(
      /bin.field/,
    );
  });

  it('refuses non-JSON', () => {
    expect(() => parseBin('iron:20')).toThrow(/must be JSON/);
  });
});

describe('parseAggregateQuery with bin', () => {
  it('carries the bin through', () => {
    const p = parseAggregateQuery({
      agg: 'count',
      bin: '{"field":"iron","mode":"count","count":12}',
    });
    expect(p.bin).toEqual({ field: 'iron', mode: 'count', count: 12 });
  });

  it('allows a category axis alongside the bin', () => {
    const p = parseAggregateQuery({
      agg: 'count',
      groupBy: 'county',
      bin: '{"field":"iron","mode":"count","count":12}',
    });
    expect(p.groupBy).toEqual(['county']);
    expect(p.bin?.field).toBe('iron');
  });

  // Both would claim the same axis, and the categorical one on a
  // measurement column is a one-bar-per-reading scatter. Refusing
  // names the conflict; answering would silently pick one.
  it('refuses the same field as both a group key and a bin', () => {
    expect(() =>
      parseAggregateQuery({
        agg: 'count',
        groupBy: 'iron',
        bin: '{"field":"iron","mode":"count","count":12}',
      }),
    ).toThrow(/already in groupBy/);
  });

  it('is in the allowlist so a binned request is not rejected', () => {
    expect(() =>
      rejectUnknownAggregateParams(['agg', 'bin']),
    ).not.toThrow();
  });
});

describe('resolveBinEdges', () => {
  const bounds = (min: number | null, max: number | null) => ({ min, max });

  it('passes explicit edges through untouched', () => {
    const bin: AggregateBin = {
      field: 'x',
      mode: 'edges',
      edges: [0.3, 1, 5],
    };
    expect(resolveBinEdges(bin, bounds(0, 100))).toEqual([0.3, 1, 5]);
  });

  // n buckets need n-1 interior thresholds. The outer two are
  // unbounded, which is what absorbs the observed min and max without
  // a separate clamp and is why this does not use width_bucket's
  // four-argument form.
  it('splits the observed range into exactly n buckets', () => {
    const edges = resolveBinEdges(
      { field: 'x', mode: 'count', count: 4 },
      bounds(0, 100),
    );
    expect(edges).toEqual([25, 50, 75]);
    expect(binRangeFor(0, edges!)).toEqual({ lower: null, upper: 25 });
    expect(binRangeFor(3, edges!)).toEqual({ lower: 75, upper: null });
  });

  it('anchors width mode on a multiple of the width, not the minimum', () => {
    // Two charts of the same field over different filters have to line
    // up, so the first edge is a round multiple rather than wherever
    // this particular selection happens to start.
    const edges = resolveBinEdges(
      { field: 'x', mode: 'width', width: 10 },
      bounds(7, 33),
    );
    expect(edges![0]).toBe(10);
    expect(binRangeFor(1, edges!)).toEqual({ lower: 10, upper: 20 });
  });

  it('covers the maximum in width mode', () => {
    const edges = resolveBinEdges(
      { field: 'x', mode: 'width', width: 10 },
      bounds(0, 25),
    );
    // The last threshold must sit at or above the max so the top
    // bucket is the open one rather than a bucket that silently
    // excludes the largest reading.
    expect(edges![edges!.length - 1]!).toBeGreaterThanOrEqual(25);
  });

  it('clamps a width that would produce more bars than pixels', () => {
    const edges = resolveBinEdges(
      { field: 'x', mode: 'width', width: 0.001 },
      bounds(0, 1000),
    );
    expect(edges!.length).toBeLessThanOrEqual(200);
  });

  // A column with no numeric values, or one where every value is the
  // same, has no distribution. Inventing a single bucket around it
  // would draw one full-height bar, which reads as a finding.
  it('returns null when the range cannot support bins', () => {
    const bin: AggregateBin = { field: 'x', mode: 'count', count: 10 };
    expect(resolveBinEdges(bin, bounds(null, null))).toBeNull();
    expect(resolveBinEdges(bin, bounds(5, 5))).toBeNull();
    expect(resolveBinEdges(bin, bounds(9, 3))).toBeNull();
  });
});

describe('binRangeFor', () => {
  const edges = [0.3, 1, 5];

  it('opens both ends', () => {
    expect(binRangeFor(0, edges)).toEqual({ lower: null, upper: 0.3 });
    expect(binRangeFor(3, edges)).toEqual({ lower: 5, upper: null });
  });

  it('is half-open in the middle, so adjacent buckets do not overlap', () => {
    expect(binRangeFor(1, edges)).toEqual({ lower: 0.3, upper: 1 });
    expect(binRangeFor(2, edges)).toEqual({ lower: 1, upper: 5 });
  });
});
