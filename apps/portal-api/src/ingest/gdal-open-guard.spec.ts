// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  assertAllowedGdalDriver,
  assertSafeGdalOpenPath,
  hasBlockedVsi,
  resolveGdalAllowedDrivers,
} from './gdal-open-guard.js';

describe('gdal-open-guard (#234)', () => {
  it('allows local paths and /vsizip/ /vsis3/', () => {
    expect(hasBlockedVsi('/tmp/upload.gpkg')).toBe(false);
    expect(hasBlockedVsi('/vsizip//tmp/upload.zip')).toBe(false);
    expect(hasBlockedVsi('/vsis3/bucket/key.tif')).toBe(false);
  });

  it('blocks /vsicurl/ open paths', () => {
    expect(
      hasBlockedVsi('/vsicurl/http://169.254.169.254/latest/meta-data/'),
    ).toBe(true);
    expect(() =>
      assertSafeGdalOpenPath({
        openPath: '/vsicurl/http://evil.example/x',
        sourceName: 'x.tif',
      }),
    ).toThrow(/network path/);
  });

  it('blocks VRT bodies that name /vsicurl/ or absolute http SourceFilename', () => {
    const vrt = `<VRTDataset>
  <VRTRasterBand>
    <SimpleSource>
      <SourceFilename relativeToVRT="0">/vsicurl/http://169.254.169.254/x</SourceFilename>
    </SimpleSource>
  </VRTRasterBand>
</VRTDataset>`;
    expect(() =>
      assertSafeGdalOpenPath({
        openPath: '/tmp/evil.vrt',
        sourceName: 'evil.vrt',
        fileBytes: vrt,
      }),
    ).toThrow(/network path/);

    const httpSrc = `<VRTDataset>
  <SourceFilename>https://evil.example/a.tif</SourceFilename>
</VRTDataset>`;
    expect(() =>
      assertSafeGdalOpenPath({
        openPath: '/tmp/http.vrt',
        sourceName: 'http.vrt',
        fileBytes: httpSrc,
      }),
    ).toThrow(/HTTP/);
  });

  it('allows a local-relative VRT', () => {
    const vrt = `<VRTDataset>
  <SourceFilename relativeToVRT="1">chunk.tif</SourceFilename>
</VRTDataset>`;
    expect(() =>
      assertSafeGdalOpenPath({
        openPath: '/tmp/ok.vrt',
        sourceName: 'ok.vrt',
        fileBytes: vrt,
      }),
    ).not.toThrow();
  });

  it('allows common vector drivers and refuses VRT by default', () => {
    expect(() => assertAllowedGdalDriver('GeoJSON')).not.toThrow();
    expect(() => assertAllowedGdalDriver('GPKG')).not.toThrow();
    expect(() => assertAllowedGdalDriver('ESRI Shapefile')).not.toThrow();
    expect(() => assertAllowedGdalDriver('CSV')).not.toThrow();
    expect(() => assertAllowedGdalDriver('OpenFileGDB')).not.toThrow();
    expect(() => assertAllowedGdalDriver('VRT')).toThrow(/not allowed/);
    expect(() => assertAllowedGdalDriver('')).toThrow(/unknown driver/);
  });

  it('honours GDAL_ALLOWED_DRIVERS overrides', () => {
    const prev = process.env['GDAL_ALLOWED_DRIVERS'];
    try {
      process.env['GDAL_ALLOWED_DRIVERS'] = 'GeoJSON,VRT';
      const allowed = resolveGdalAllowedDrivers();
      expect(allowed.has('geojson')).toBe(true);
      expect(allowed.has('vrt')).toBe(true);
      expect(allowed.has('gpkg')).toBe(false);
      expect(() => assertAllowedGdalDriver('VRT')).not.toThrow();
      expect(() => assertAllowedGdalDriver('GPKG')).toThrow(/not allowed/);
    } finally {
      if (prev === undefined) delete process.env['GDAL_ALLOWED_DRIVERS'];
      else process.env['GDAL_ALLOWED_DRIVERS'] = prev;
    }
  });
});
