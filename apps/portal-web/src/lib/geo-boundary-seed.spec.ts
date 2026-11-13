// SPDX-License-Identifier: AGPL-3.0-or-later
import { planBoundarySeed } from './geo-boundary-seed';

describe('planBoundarySeed', () => {
  it('rounds to 9 decimals and drops altitude', () => {
    const plan = planBoundarySeed({
      type: 'Polygon',
      coordinates: [
        [
          [-117.123456789012345, 33.987654321098765, 120],
          [-117.1, 34.1, 120],
          [-117.2, 34.1, 120],
          [-117.123456789012345, 33.987654321098765, 120],
        ],
      ],
    });
    expect(plan.readOnly).toBe(false);
    const ring = plan.polygons[0]![0]!;
    expect(ring[0]).toEqual([-117.123456789, 33.987654321]);
    for (const pt of ring) {
      expect(pt).toHaveLength(2);
      for (const n of pt) {
        const decimals = (String(n).split('.')[1] ?? '').length;
        expect(decimals).toBeLessThanOrEqual(9);
      }
    }
  });

  it('splits a MultiPolygon into one polygon per part', () => {
    const square = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
    const plan = planBoundarySeed({ type: 'MultiPolygon', coordinates: [square, square] });
    expect(plan.polygons).toHaveLength(2);
  });

  it('marks a boundary with holes as read-only', () => {
    const plan = planBoundarySeed({
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 0]],
        [[1, 1], [2, 1], [2, 2], [1, 1]],
      ],
    });
    expect(plan).toEqual({ polygons: [], readOnly: true });
  });
});
