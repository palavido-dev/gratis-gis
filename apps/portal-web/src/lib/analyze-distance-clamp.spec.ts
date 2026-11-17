// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The four Analyze distance inputs run their clamp helper on every
 * keystroke. A value under the cap must come back exactly as typed:
 * converting feet to metres and back gave 6.999999999999999 for 7,
 * and the input then showed that instead of what the user typed.
 */
import type { LengthUnit } from '@gratis-gis/shared-types';
import { clampBufferDistance } from './analyze-buffer-derived';
import { clampDensifySegmentLength } from './analyze-densify-derived';
import { clampFishnetCellSize } from './analyze-fishnet-derived';
import { clampSimplifyTolerance } from './analyze-simplify-derived';

const HELPERS: Array<[string, (v: number, u: LengthUnit) => number]> = [
  ['buffer', clampBufferDistance],
  ['densify', clampDensifySegmentLength],
  ['fishnet', clampFishnetCellSize],
  ['simplify', clampSimplifyTolerance],
];
const UNITS: LengthUnit[] = ['feet', 'miles', 'yards', 'meters', 'kilometers'];

describe.each(HELPERS)('%s clamp', (_name, clamp) => {
  it.each(UNITS)('returns every whole number 1..1000 %s exactly as typed', (unit) => {
    // Every helper caps at 100 km, which is above 1000 of any unit
    // except miles and kilometres, so stop those at 50.
    const top = unit === 'miles' || unit === 'kilometers' ? 50 : 1000;
    for (let v = 1; v <= top; v++) expect(clamp(v, unit)).toBe(v);
    expect(clamp(2.25, unit)).toBe(2.25);
  });

  it('still caps a value over the 100 km limit', () => {
    expect(clamp(200, 'kilometers')).toBe(100);
    expect(clamp(1e9, 'feet')).toBeCloseTo(100_000 / 0.3048, 6);
  });
});
