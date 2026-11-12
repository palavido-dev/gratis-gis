// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GDAL chooses a driver from a file's bytes. A VRT saved under a
// GeoTIFF or GeoJSON name opened as VRT and read the sources it named.
// portal-api now loads GDAL with those drivers skipped, and raster
// uploads must carry the right magic bytes.
//
// GDAL registers its drivers once per process, so the load runs in a
// child process where nothing else has loaded gdal-async yet.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rasterMagicMatches } from './gdal-open-guard.js';
import { GDAL_SKIPPED_DRIVERS } from '../common/gdal-load.js';

const CHILD = `
const g = require('gdal-async');
const fs = require('fs');
const path = require('path');
const dir = process.argv[1];
const tif = path.join(dir, 'a.tif');
g.open(tif, 'w', 'GTiff', 4, 4, 1, g.GDT_Byte).close();
const vrt = '<VRTDataset rasterXSize="4" rasterYSize="4"><VRTRasterBand dataType="Byte" band="1"><SimpleSource><SourceFilename>' + tif + '</SourceFilename><SourceBand>1</SourceBand></SimpleSource></VRTRasterBand></VRTDataset>';
fs.writeFileSync(path.join(dir, 'b.tif'), vrt);
fs.writeFileSync(path.join(dir, 'c.geojson'), vrt);
fs.writeFileSync(path.join(dir, 'd.geojson'), '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"a":1},"geometry":{"type":"Point","coordinates":[1,2]}}]}');
const out = {};
for (const f of ['a.tif', 'b.tif', 'c.geojson', 'd.geojson']) {
  try { out[f] = g.open(path.join(dir, f)).driver.description; } catch { out[f] = 'refused'; }
}
out.skip = process.env.GDAL_SKIP || null;
console.log(JSON.stringify(out));
`;

function runChild(env: NodeJS.ProcessEnv): Record<string, string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'gg-pin-'));
  const out = execFileSync(process.execPath, ['-e', CHILD, dir], {
    env: { ...process.env, ...env },
    cwd: join(__dirname, '../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe('GDAL driver skipping', () => {
  it('without GDAL_SKIP a disguised VRT opens as VRT (the hole)', () => {
    const r = runChild({ GDAL_SKIP: '' });
    expect(r['b.tif']).toBe('VRT');
    expect(r['c.geojson']).toBe('VRT');
  });

  it('with the hardened skip list the VRT is refused and real files still open', () => {
    const r = runChild({ GDAL_SKIP: GDAL_SKIPPED_DRIVERS.join(' ') });
    expect(r['b.tif']).toBe('refused');
    expect(r['c.geojson']).toBe('refused');
    expect(r['a.tif']).toBe('GTiff');
    expect(r['d.geojson']).toBe('GeoJSON');
  });

  it('checks raster magic bytes', () => {
    expect(rasterMagicMatches('tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe(true);
    expect(rasterMagicMatches('tiff', Buffer.from([0x4d, 0x4d, 0x00, 0x2b]))).toBe(true);
    expect(rasterMagicMatches('tiff', Buffer.from('<VRTDataset'))).toBe(false);
    expect(
      rasterMagicMatches('jp2', Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])),
    ).toBe(true);
    expect(rasterMagicMatches('jp2', Buffer.from([0xff, 0x4f, 0xff, 0x51]))).toBe(true);
    expect(rasterMagicMatches('jp2', Buffer.from('<x'))).toBe(false);
  });
});
