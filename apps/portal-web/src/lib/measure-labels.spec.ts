// SPDX-License-Identifier: AGPL-3.0-or-later
import { ringAreaSquareMeters, SQM_PER_ACRE } from './measure';
import {
  dimensionLabelFeatures,
  formatSegmentLength,
  scaleRingToArea,
  segmentTextRotation,
  type DimensionLabelProps,
} from './measure-labels';

type Pos = [number, number];
// Roughly a 200 m square near Elkins, WV.
const square: Pos[] = [
  [-79.85, 38.92],
  [-79.8477, 38.92],
  [-79.8477, 38.9218],
  [-79.85, 38.9218],
  [-79.85, 38.92],
];
const opts = { lengths: true, area: true, lengthUnit: 'miles', areaUnit: 'acres' } as const;
const props = (f: GeoJSON.Feature) => f.properties as DimensionLabelProps;

describe('formatSegmentLength', () => {
  it('drops to feet or meters for short sides', () => {
    expect(formatSegmentLength(100, 'miles')).toMatch(/ft$/);
    expect(formatSegmentLength(372, 'miles')).toMatch(/ft$/);
    expect(formatSegmentLength(5000, 'miles')).toMatch(/mi$/);
    expect(formatSegmentLength(100, 'kilometers')).toMatch(/ m$/);
    expect(formatSegmentLength(100, 'feet')).toMatch(/ft$/);
  });
});

describe('segmentTextRotation', () => {
  it('follows the segment and never reads upside down', () => {
    expect(segmentTextRotation([0, 0], [1, 0])).toBeCloseTo(0);
    expect(segmentTextRotation([1, 0], [0, 0])).toBeCloseTo(0);
    expect(Math.abs(segmentTextRotation([0, 0], [0, 1]))).toBeCloseTo(90);
    // North-east on screen runs up to the right: a negative (counter-clockwise) turn.
    expect(segmentTextRotation([0, 0], [1, 1])).toBeLessThan(0);
    for (const b of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as Pos[]) {
      const r = segmentTextRotation([0, 0], b);
      expect(r).toBeGreaterThan(-90.001);
      expect(r).toBeLessThanOrEqual(90);
    }
  });
});

describe('dimensionLabelFeatures', () => {
  it('labels each side and the area of a polygon', () => {
    const labels = dimensionLabelFeatures({ type: 'Polygon', coordinates: [square] }, opts);
    expect(labels.filter((f) => props(f).role === 'segment')).toHaveLength(4);
    const area = labels.filter((f) => props(f).role === 'area');
    expect(area).toHaveLength(1);
    expect(props(area[0]!).text).toMatch(/ac$/);
    expect(props(labels[0]!).text).toMatch(/ft$/);
  });

  it('honours each toggle on its own', () => {
    const g = { type: 'Polygon', coordinates: [square] };
    expect(dimensionLabelFeatures(g, { ...opts, lengths: false }).map((f) => props(f).role)).toEqual(['area']);
    expect(dimensionLabelFeatures(g, { ...opts, area: false }).every((f) => props(f).role === 'segment')).toBe(true);
    expect(dimensionLabelFeatures(g, { ...opts, lengths: false, area: false })).toEqual([]);
  });

  it('labels a line with its segments and a total, and a single segment with no total', () => {
    const line = { type: 'LineString', coordinates: square.slice(0, 3) };
    expect(dimensionLabelFeatures(line, opts).map((f) => props(f).role)).toEqual(['segment', 'segment', 'total']);
    const one = { type: 'LineString', coordinates: square.slice(0, 2) };
    expect(dimensionLabelFeatures(one, opts).map((f) => props(f).role)).toEqual(['segment']);
  });

  it('copes with a half-drawn polygon, duplicate points and junk', () => {
    const partial = { type: 'Polygon', coordinates: [[square[0], square[1], square[1], square[0]]] };
    const labels = dimensionLabelFeatures(partial, opts);
    expect(labels.every((f) => props(f).role === 'segment')).toBe(true);
    expect(dimensionLabelFeatures({ type: 'Point', coordinates: [0, 0] }, opts)).toEqual([]);
    expect(dimensionLabelFeatures(null, opts)).toEqual([]);
    expect(dimensionLabelFeatures({ type: 'Polygon', coordinates: 'x' }, opts)).toEqual([]);
  });
});

describe('scaleRingToArea', () => {
  it('scales to the target area and keeps the middle and the closing point', () => {
    const target = 10 * SQM_PER_ACRE;
    const out = scaleRingToArea(square, target)!;
    expect(out).toHaveLength(square.length);
    expect(out[0]).toEqual(out[out.length - 1]);
    expect(ringAreaSquareMeters(out) / target).toBeCloseTo(1, 6);
    const mid = (r: Pos[]) => [
      r.slice(0, -1).reduce((s, p) => s + p[0], 0) / (r.length - 1),
      r.slice(0, -1).reduce((s, p) => s + p[1], 0) / (r.length - 1),
    ];
    expect(mid(out)[0]).toBeCloseTo(mid(square)[0]!, 9);
    expect(mid(out)[1]).toBeCloseTo(mid(square)[1]!, 9);
  });

  it('refuses a bad target or a ring with no area', () => {
    expect(scaleRingToArea(square, 0)).toBeNull();
    expect(scaleRingToArea(square, Number.NaN)).toBeNull();
    expect(scaleRingToArea([square[0]!, square[1]!], 100)).toBeNull();
    expect(scaleRingToArea([square[0]!, square[0]!, square[0]!, square[0]!], 100)).toBeNull();
  });
});
