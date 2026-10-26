// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  assertSafeGdalOpenPath,
  hasBlockedVsi,
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
});
