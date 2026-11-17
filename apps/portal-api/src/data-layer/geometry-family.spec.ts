// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { assertGeometryFamilies } from './geometry-family.js';

const point = { type: 'Point', coordinates: [1, 2] };
const multiPoint = { type: 'MultiPoint', coordinates: [[1, 2]] };
const line = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const multiPolygon = { type: 'MultiPolygon', coordinates: [polygon.coordinates] };

function refusal(fn: () => void): { message: string; offendingIndices: number[] } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as never;
  }
  throw new Error('expected a refusal');
}

describe('assertGeometryFamilies', () => {
  it('refuses a Point on a polygon layer with a clear message', () => {
    const r = refusal(() => assertGeometryFamilies('polygon', [point]));
    expect(r.message).toBe('This layer holds polygons, so a Point cannot be saved to it.');
    expect(r.offendingIndices).toEqual([0]);
  });

  it('names the offending rows of a batch', () => {
    const r = refusal(() => assertGeometryFamilies('line', [line, polygon, null, point]));
    expect(r.offendingIndices).toEqual([1, 3]);
    expect(r.message).toMatch(/2 of the features/);
  });

  it('accepts the Multi form of the declared type', () => {
    expect(() => assertGeometryFamilies('polygon', [polygon, multiPolygon])).not.toThrow();
    expect(() => assertGeometryFamilies('point', [point, multiPoint])).not.toThrow();
  });

  it('accepts attribute-only writes', () => {
    expect(() => assertGeometryFamilies('point', [null, undefined])).not.toThrow();
  });

  it('keeps accepting everything on layers without a declared type', () => {
    for (const declared of [null, undefined, 'any', 'mixed', 'Polygon']) {
      expect(() => assertGeometryFamilies(declared, [point, line, polygon])).not.toThrow();
    }
  });

  it('checks the members of a GeometryCollection', () => {
    const gc = (geometries: unknown[]) => ({ type: 'GeometryCollection', geometries });
    expect(() => assertGeometryFamilies('polygon', [gc([polygon, multiPolygon])])).not.toThrow();
    expect(() => assertGeometryFamilies('polygon', [gc([polygon, point])])).toThrow(
      BadRequestException,
    );
  });

  it('leaves unrecognised shapes to the other validation', () => {
    expect(() => assertGeometryFamilies('point', [{ type: 'Circle' }, 'x'])).not.toThrow();
  });
});
