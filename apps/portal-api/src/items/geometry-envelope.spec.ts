// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  envelopeOfGeometries,
  envelopeStrictlyInside,
  envelopesEqual,
  geometryEnvelope,
  readStoredEnvelope,
  unionEnvelopes,
} from './geometry-envelope.js';

/**
 * The incremental bbox path replaces an ST_Extent over the whole
 * observation scope with arithmetic over what was just written. That
 * is only exact if this helper agrees with ST_Extent on every
 * geometry type, so every type gets a case here.
 */
describe('geometryEnvelope', () => {
  it('Point', () => {
    expect(geometryEnvelope({ type: 'Point', coordinates: [-80, 38.5] })).toEqual([
      -80, 38.5, -80, 38.5,
    ]);
  });

  it('MultiPoint and LineString bound every vertex', () => {
    const coords = [
      [-80, 38],
      [-79, 39],
      [-81, 38.5],
    ];
    expect(geometryEnvelope({ type: 'MultiPoint', coordinates: coords })).toEqual([
      -81, 38, -79, 39,
    ]);
    expect(geometryEnvelope({ type: 'LineString', coordinates: coords })).toEqual([
      -81, 38, -79, 39,
    ]);
  });

  it('MultiLineString and Polygon (outer ring plus holes)', () => {
    expect(
      geometryEnvelope({
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [-2, 3],
            [4, -5],
          ],
        ],
      }),
    ).toEqual([-2, -5, 4, 3]);
    expect(
      geometryEnvelope({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 3],
            [2, 2],
          ],
        ],
      }),
    ).toEqual([0, 0, 10, 10]);
  });

  it('MultiPolygon', () => {
    expect(
      geometryEnvelope({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [6, 5],
              [6, 7],
              [5, 5],
            ],
          ],
        ],
      }),
    ).toEqual([0, 0, 6, 7]);
  });

  it('GeometryCollection unions its members, recursively', () => {
    expect(
      geometryEnvelope({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 1] },
          {
            type: 'GeometryCollection',
            geometries: [{ type: 'LineString', coordinates: [[-3, 2], [0, -4]] }],
          },
          null,
        ],
      }),
    ).toEqual([-3, -4, 1, 2]);
    expect(geometryEnvelope({ type: 'GeometryCollection', geometries: [] })).toBeNull();
  });

  it('ignores altitude and skips non finite positions', () => {
    expect(
      geometryEnvelope({
        type: 'LineString',
        coordinates: [
          [1, 2, 300],
          [Number.NaN, 5],
          [3, Number.POSITIVE_INFINITY],
          [4, 6, 900],
        ],
      }),
    ).toEqual([1, 2, 4, 6]);
    expect(
      geometryEnvelope({ type: 'Point', coordinates: [Number.NaN, 1] }),
    ).toBeNull();
  });

  it('returns null for null, non objects, unknown types and empty coordinates', () => {
    expect(geometryEnvelope(null)).toBeNull();
    expect(geometryEnvelope(undefined)).toBeNull();
    expect(geometryEnvelope('POINT(1 1)')).toBeNull();
    expect(geometryEnvelope({ type: 'Circle', coordinates: [1, 1] })).toBeNull();
    expect(geometryEnvelope({ type: 'Polygon', coordinates: [] })).toBeNull();
    expect(geometryEnvelope({ type: 'Point' })).toBeNull();
  });

  it('does not special case the antimeridian, matching ST_Extent', () => {
    // A line from Fiji to Samoa crosses 180. ST_Extent reports the
    // naive envelope spanning nearly the whole world, and so must we,
    // or the incremental path and the full recompute would disagree
    // about the same rows.
    expect(
      geometryEnvelope({
        type: 'LineString',
        coordinates: [
          [178, -18],
          [-172, -13],
        ],
      }),
    ).toEqual([-172, -18, 178, -13]);
  });
});

describe('envelopeOfGeometries', () => {
  it('unions a batch and ignores null entries', () => {
    expect(
      envelopeOfGeometries([
        null,
        { type: 'Point', coordinates: [1, 1] },
        undefined,
        { type: 'Point', coordinates: [-1, 3] },
      ]),
    ).toEqual([-1, 1, 1, 3]);
  });

  it('is null when nothing in the batch has geometry', () => {
    expect(envelopeOfGeometries([])).toBeNull();
    expect(envelopeOfGeometries([null, null])).toBeNull();
  });
});

describe('unionEnvelopes / envelopesEqual', () => {
  it('union treats null as the empty set and never aliases its inputs', () => {
    const a: [number, number, number, number] = [0, 0, 1, 1];
    expect(unionEnvelopes(null, null)).toBeNull();
    const fromA = unionEnvelopes(a, null);
    expect(fromA).toEqual(a);
    expect(fromA).not.toBe(a);
    expect(unionEnvelopes(null, a)).toEqual(a);
    expect(unionEnvelopes(a, [-1, 0.5, 0.5, 2])).toEqual([-1, 0, 1, 2]);
  });

  it('equality is exact and null only equals null', () => {
    expect(envelopesEqual(null, null)).toBe(true);
    expect(envelopesEqual([0, 0, 1, 1], null)).toBe(false);
    expect(envelopesEqual([0, 0, 1, 1], [0, 0, 1, 1])).toBe(true);
    expect(envelopesEqual([0, 0, 1, 1], [0, 0, 1, 1.0000001])).toBe(false);
  });
});

describe('envelopeStrictlyInside', () => {
  const outer: [number, number, number, number] = [-10, -10, 10, 10];

  it('is true only when no edge is touched', () => {
    expect(envelopeStrictlyInside([-9, -9, 9, 9], outer)).toBe(true);
    expect(envelopeStrictlyInside([0, 0, 0, 0], outer)).toBe(true);
  });

  it('touching any single edge is enough to fail', () => {
    expect(envelopeStrictlyInside([-10, -9, 9, 9], outer)).toBe(false);
    expect(envelopeStrictlyInside([-9, -10, 9, 9], outer)).toBe(false);
    expect(envelopeStrictlyInside([-9, -9, 10, 9], outer)).toBe(false);
    expect(envelopeStrictlyInside([-9, -9, 9, 10], outer)).toBe(false);
  });

  it('exceeding an edge fails too', () => {
    expect(envelopeStrictlyInside([-9, -9, 11, 9], outer)).toBe(false);
    expect(envelopeStrictlyInside([-20, -20, 20, 20], outer)).toBe(false);
  });
});

describe('readStoredEnvelope', () => {
  it('reads a four number array and rejects the empty marker and garbage', () => {
    expect(readStoredEnvelope([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(readStoredEnvelope([])).toBeNull();
    expect(readStoredEnvelope(null)).toBeNull();
    expect(readStoredEnvelope([1, 2, 3])).toBeNull();
    expect(readStoredEnvelope(['1', '2', '3', '4'])).toBeNull();
    expect(readStoredEnvelope([1, 2, 3, Number.NaN])).toBeNull();
  });
});
