// SPDX-License-Identifier: AGPL-3.0-or-later
import { featuresBbox, geometryBbox } from './geo-bbox';

describe('geo-bbox', () => {
  it('covers points, lines and polygons', () => {
    expect(
      featuresBbox([
        { geometry: { type: 'Point', coordinates: [1, 2] } },
        { geometry: { type: 'LineString', coordinates: [[-3, 0], [4, 5, 100]] } },
        { geometry: { type: 'Polygon', coordinates: [[[0, -1], [1, 1], [0, 0], [0, -1]]] } },
      ]),
    ).toEqual([-3, -1, 4, 5]);
  });

  it('includes GeometryCollection members', () => {
    expect(
      geometryBbox({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [10, 10] },
          { type: 'Point', coordinates: [-10, 20] },
        ],
      }),
    ).toEqual([-10, 10, 10, 20]);
  });

  it('returns null with no usable coordinate', () => {
    expect(featuresBbox([])).toBeNull();
    expect(featuresBbox([{ geometry: null }])).toBeNull();
    expect(geometryBbox({ type: 'Point', coordinates: [NaN, 1] })).toBeNull();
  });
});
