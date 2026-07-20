// SPDX-License-Identifier: AGPL-3.0-or-later
import { boundsToWgs84, extractHorizontalCs } from './bbox-wgs84.js';

/** NAD83(2011) / Conus Albers (EPSG:6350), the horizontal CS the
 *  USGS 3DEP WV FEMA HQ 2018 delivery uses. */
const CONUS_ALBERS =
  'PROJCS["NAD83(2011) / Conus Albers",GEOGCS["NAD83(2011)",DATUM["NAD83_National_Spatial_Reference_System_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Albers_Conic_Equal_Area"],PARAMETER["latitude_of_center",23],PARAMETER["longitude_of_center",-96],PARAMETER["standard_parallel_1",29.5],PARAMETER["standard_parallel_2",45.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';

/** Same thing wrapped in the compound (horizontal + vertical) form
 *  lidar files actually carry. */
const COMPOUND = `COMPD_CS["NAD83(2011) / Conus Albers + NAVD88 height",${CONUS_ALBERS},VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["metre",1],AXIS["Up",UP]]]`;

/** Native bounds of the merged WV FEMA HQ block (16 one-km tiles). */
const WV_BOUNDS: [number, number, number, number, number, number] = [
  1363000.01, 1859000.01, 568.83, 1368000, 1863000, 1090.32,
];

describe('extractHorizontalCs', () => {
  it('returns a bare PROJCS unchanged', () => {
    expect(extractHorizontalCs(CONUS_ALBERS)).toBe(CONUS_ALBERS);
  });

  it('pulls the PROJCS out of a COMPD_CS by balanced brackets', () => {
    expect(extractHorizontalCs(COMPOUND)).toBe(CONUS_ALBERS);
  });

  it('returns null for WKT without a horizontal CS or with broken nesting', () => {
    expect(extractHorizontalCs('VERT_CS["NAVD88",VERT_DATUM["x",2005]]')).toBeNull();
    expect(extractHorizontalCs('PROJCS["broken",GEOGCS["x"')).toBeNull();
  });
});

describe('boundsToWgs84', () => {
  it('lands the WV block in West Virginia', () => {
    const bbox = boundsToWgs84(WV_BOUNDS, COMPOUND);
    expect(bbox).not.toBeNull();
    const [west, south, east, north] = bbox!;
    // Loose ranges on purpose: this asserts "correct part of the
    // planet at the right size", not proj4's exact rounding.
    expect(west).toBeGreaterThan(-80.5);
    expect(east).toBeLessThan(-79.4);
    expect(south).toBeGreaterThan(38.4);
    expect(north).toBeLessThan(39.2);
    expect(east).toBeGreaterThan(west);
    expect(north).toBeGreaterThan(south);
    // ~5 km x ~4 km block: spans should be a few hundredths of a
    // degree, never a whole degree.
    expect(east - west).toBeLessThan(0.2);
    expect(north - south).toBeLessThan(0.2);
  });

  it('returns null when the WKT is absent or unusable', () => {
    expect(boundsToWgs84(WV_BOUNDS, null)).toBeNull();
    expect(boundsToWgs84(WV_BOUNDS, 'not wkt at all')).toBeNull();
  });
});
