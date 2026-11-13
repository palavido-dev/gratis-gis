// SPDX-License-Identifier: AGPL-3.0-or-later
// Turning a saved boundary into polygons the Draw tab can edit.
//
// terra-draw only accepts single-ring polygons with two-number
// coordinates of at most 9 decimal places. Typical GIS exports carry
// 15 decimals, KML carries altitude, and real boundaries have holes,
// so a saved boundary usually failed that check. terra-draw does not
// throw for a rejected feature, it just leaves it out, and the Draw
// tab showed an empty map as if the boundary were gone.

/** Decimal places terra-draw accepts by default. */
const MAX_DECIMALS = 9;

export interface SeedPlan {
  /** Rings to hand to terra-draw, one polygon each. */
  polygons: number[][][][];
  /** True when the boundary has a polygon terra-draw cannot hold (a
   *  hole), so the editor shows it read-only instead of seeding. */
  readOnly: boolean;
}

function round(n: number): number {
  return Number(n.toFixed(MAX_DECIMALS));
}

/**
 * Plan how to show `geometry` in the Draw tab. Coordinates are cut to
 * two numbers (dropping altitude) and rounded to the precision
 * terra-draw accepts. A polygon with holes cannot be edited there.
 */
export function planBoundarySeed(geometry: {
  type: string;
  coordinates: unknown;
}): SeedPlan {
  const polys: number[][][][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as number[][][][])
        : [];
  if (polys.some((rings) => rings.length !== 1)) {
    return { polygons: [], readOnly: true };
  }
  return {
    polygons: polys.map((rings) =>
      rings.map((ring) => ring.map((pt) => [round(pt[0]!), round(pt[1]!)])),
    ),
    readOnly: false,
  };
}
