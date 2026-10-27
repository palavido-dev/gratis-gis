// SPDX-License-Identifier: AGPL-3.0-or-later
import { needsServerGdalStage } from './server-gdal-stage';

describe('needsServerGdalStage', () => {
  it('routes .gdb and .gdb.zip through server GDAL staging', () => {
    expect(needsServerGdalStage('parcels.gdb.zip')).toBe(true);
    expect(needsServerGdalStage('Parcels.GDB')).toBe(true);
  });

  it('leaves browser / direct-import formats alone', () => {
    expect(needsServerGdalStage('parcels.geojson')).toBe(false);
    expect(needsServerGdalStage('parcels.kml')).toBe(false);
    expect(needsServerGdalStage('parcels.kmz')).toBe(false);
    // Plain .zip is still the shapefile branch for detectFormat.
    expect(needsServerGdalStage('parcels.zip')).toBe(false);
  });
});
