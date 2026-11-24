// SPDX-License-Identifier: AGPL-3.0-or-later
import { vertexCount } from './markup-append';

describe('vertexCount', () => {
  it('counts vertices at any depth', () => {
    expect(vertexCount({ type: 'Point', coordinates: [1, 2] })).toBe(1);
    expect(vertexCount({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toBe(4);
    expect(
      vertexCount({
        type: 'MultiPolygon',
        coordinates: [[[[0, 0], [1, 0], [0, 0]]], [[[2, 2], [3, 2], [2, 2]]]],
      }),
    ).toBe(6);
    expect(
      vertexCount({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
        ],
      }),
    ).toBe(3);
  });
});
