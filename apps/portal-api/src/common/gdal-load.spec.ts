// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadGdalHardened, gdalHasDriver } from './gdal-load.js';

describe('loadGdalHardened', () => {
  it('restores GDAL_SKIP after loading so child GDAL tools are unaffected', async () => {
    delete process.env['GDAL_SKIP'];
    const gdal = await loadGdalHardened();
    expect(process.env['GDAL_SKIP']).toBeUndefined();
    expect(gdalHasDriver(gdal, 'GTiff')).toBe(true);
  });
});
