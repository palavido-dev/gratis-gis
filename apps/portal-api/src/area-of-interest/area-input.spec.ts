// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  MAX_DISTANCE_METERS,
  parseAreaId,
  parseAreaInput,
} from './area-input.js';

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [-117, 34],
      [-116.99, 34],
      [-116.99, 34.01],
      [-117, 34.01],
      [-117, 34],
    ],
  ],
};

function rejects(body: unknown): void {
  expect(() => parseAreaInput(body)).toThrow(BadRequestException);
}

describe('parseAreaInput', () => {
  it('takes a polygon with no distance as distance 0', () => {
    expect(parseAreaInput({ geometry: square })).toEqual({
      geometry: square,
      distanceMeters: 0,
    });
  });

  it('takes a point with a distance', () => {
    const out = parseAreaInput({
      geometry: { type: 'Point', coordinates: [-117, 34] },
      distanceMeters: 152.4,
    });
    expect(out.distanceMeters).toBe(152.4);
  });

  it('takes picked features as a geometry collection', () => {
    expect(() =>
      parseAreaInput({
        geometry: {
          type: 'GeometryCollection',
          geometries: [square, { type: 'MultiPolygon', coordinates: [square.coordinates] }],
        },
      }),
    ).not.toThrow();
  });

  it('refuses a body that is not an object', () => {
    rejects(null);
    rejects([]);
    rejects('x');
  });

  it('refuses unknown geometry types and Features', () => {
    rejects({ geometry: { type: 'Circle', coordinates: [0, 0] } });
    rejects({ geometry: { type: 'Feature', geometry: square } });
  });

  it('refuses coordinates that are not lon/lat degrees', () => {
    rejects({ geometry: { type: 'Point', coordinates: [500000, 3700000] } });
    rejects({ geometry: { type: 'Point', coordinates: [-117, Number.NaN] } });
    rejects({ geometry: { type: 'Point', coordinates: ['-117', '34'] } });
  });

  it('refuses rings and lines too short to be shapes', () => {
    rejects({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] } });
    rejects({ geometry: { type: 'LineString', coordinates: [[0, 0]] } });
    rejects({ geometry: { type: 'GeometryCollection', geometries: [] } });
  });

  it('refuses collections nested past the limit', () => {
    let g: Record<string, unknown> = square;
    for (let i = 0; i < 6; i++) g = { type: 'GeometryCollection', geometries: [g] };
    rejects({ geometry: g });
  });

  it('bounds the distance', () => {
    rejects({ geometry: square, distanceMeters: -1 });
    rejects({ geometry: square, distanceMeters: MAX_DISTANCE_METERS + 1 });
    rejects({ geometry: square, distanceMeters: '100' });
    rejects({ geometry: square, distanceMeters: Number.POSITIVE_INFINITY });
  });
});

describe('parseAreaId', () => {
  it('passes an absent id through', () => {
    expect(parseAreaId(undefined)).toBeUndefined();
    expect(parseAreaId('')).toBeUndefined();
  });

  it('takes 32 lowercase hex characters', () => {
    expect(parseAreaId('0123456789abcdef0123456789abcdef')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
  });

  it('refuses anything else', () => {
    expect(() => parseAreaId('0123456789ABCDEF0123456789ABCDEF')).toThrow(
      BadRequestException,
    );
    expect(() => parseAreaId("x' OR 1=1")).toThrow(BadRequestException);
    expect(() => parseAreaId(['a', 'b'])).toThrow(BadRequestException);
  });
});
