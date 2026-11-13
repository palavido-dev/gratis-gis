// SPDX-License-Identifier: AGPL-3.0-or-later
import { isShareClipGeometry } from './share-clip';

const square = [
  [
    [-118, 34],
    [-117, 34],
    [-117, 35],
    [-118, 35],
    [-118, 34],
  ],
];

describe('isShareClipGeometry', () => {
  it('accepts closed WGS84 polygons, multipolygons and collections of them', () => {
    expect(isShareClipGeometry({ type: 'Polygon', coordinates: square })).toBe(true);
    expect(isShareClipGeometry({ type: 'MultiPolygon', coordinates: [square] })).toBe(true);
    expect(
      isShareClipGeometry({
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', coordinates: square }],
      }),
    ).toBe(true);
  });

  it('refuses a polygon with no coordinates', () => {
    expect(isShareClipGeometry({ type: 'Polygon' })).toBe(false);
  });

  it('refuses projected coordinates and open rings', () => {
    expect(
      isShareClipGeometry({
        type: 'Polygon',
        coordinates: [[[500000, 3700000], [500100, 3700000], [500100, 3700100], [500000, 3700000]]],
      }),
    ).toBe(false);
    expect(
      isShareClipGeometry({ type: 'Polygon', coordinates: [square[0]!.slice(0, 4)] }),
    ).toBe(false);
  });

  it('refuses other geometry types and the closed sentinel', () => {
    expect(isShareClipGeometry({ type: 'Point', coordinates: [0, 0] })).toBe(false);
    expect(isShareClipGeometry({ closed: true })).toBe(false);
    expect(isShareClipGeometry('Polygon')).toBe(false);
  });
});
