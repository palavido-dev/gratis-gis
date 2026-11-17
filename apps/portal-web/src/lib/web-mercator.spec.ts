// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  metersPerPixel,
  scaleBar,
  scaleDenominator,
  zoomForScale,
} from './web-mercator';

describe('web-mercator on MapLibre zoom', () => {
  it('uses 512 px tiles', () => {
    // At zoom 0 the 40,075 km equator spans 512 px.
    expect(metersPerPixel(0, 0)).toBeCloseTo(40_075_016.686 / 512, 3);
    // Half the 256-px raster figure (156543 m/px).
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03392 / 2, 1);
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 6);
  });

  it('round-trips scale and zoom', () => {
    const z = zoomForScale(50_000, 34);
    expect(scaleDenominator(34, z)).toBeCloseTo(50_000, 3);
  });

  it('draws the bar at the length its label claims', () => {
    const mpp = metersPerPixel(0, 12);
    const bar = scaleBar(mpp, 80, 'metric');
    expect(bar.px).toBeLessThanOrEqual(80);
    const meters = bar.unit === 'km' ? bar.value * 1000 : bar.value;
    expect(bar.px * mpp).toBeCloseTo(meters, 6);
  });

  it('switches to miles above 1000 ft', () => {
    const bar = scaleBar(metersPerPixel(0, 10), 80, 'imperial');
    expect(bar.unit).toBe('mi');
  });
});
