// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { placedAtGpsFix } from './gps-placement';

const fix = { lon: -117, lat: 34, accuracyM: 5 };

describe('placedAtGpsFix', () => {
  it('accepts a point at the fix', () => {
    expect(placedAtGpsFix({ type: 'Point', coordinates: [-117, 34] }, fix)).toBe(true);
  });

  it('rejects a point tapped 200 m away', () => {
    // About 200 m north.
    expect(placedAtGpsFix({ type: 'Point', coordinates: [-117, 34.0018] }, fix)).toBe(false);
  });

  it('rejects lines, polygons and rows with no geometry', () => {
    expect(
      placedAtGpsFix({ type: 'LineString', coordinates: [[-117, 34], [-117, 35]] }, fix),
    ).toBe(false);
    expect(placedAtGpsFix(null, fix)).toBe(false);
  });
});
