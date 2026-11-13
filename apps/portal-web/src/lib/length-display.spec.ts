// SPDX-License-Identifier: AGPL-3.0-or-later
import { METERS_PER_UNIT } from '@gratis-gis/shared-types';
import { metersToDisplay } from './length-display';

describe('metersToDisplay', () => {
  it('round-trips typed integers in feet, miles and yards', () => {
    for (const unit of ['feet', 'miles', 'yards'] as const) {
      const f = METERS_PER_UNIT[unit];
      for (let n = 1; n <= 2000; n += 1) {
        expect(metersToDisplay(n * f, f)).toBe(n);
      }
    }
  });

  it('keeps typed decimals', () => {
    const f = METERS_PER_UNIT.feet;
    expect(metersToDisplay(7.5 * f, f)).toBe(7.5);
    expect(metersToDisplay(0.1 * f, f)).toBe(0.1);
  });
});
