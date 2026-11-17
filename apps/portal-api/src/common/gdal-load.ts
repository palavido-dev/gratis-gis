// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place portal-api loads the gdal-async native binding.
 *
 * GDAL picks a driver from a file's bytes, not its name, and some
 * drivers read other files or URLs that the file itself names: a VRT
 * (raster or OGR) lists its sources, a GDAL tile index lists tiles,
 * WMS / WMTS / WCS / STAC descriptions list servers. Saved under an
 * allowed name (x.tif, x.geojson), such a file made the server fetch
 * internal URLs and read other stored objects with the process's own
 * storage credentials, before any after-open driver check could run.
 *
 * GDAL_SKIP keeps those drivers from being registered at all in this
 * process. It is read once, when GDAL registers its drivers on first
 * load, so it is set here just before the import and then restored,
 * so that command-line GDAL tools started later (gdalwarp etc., which
 * pin their input driver with -if) are not affected. In-process warp
 * and translate do not need these drivers registered.
 */

export const GDAL_SKIPPED_DRIVERS = [
  'VRT',
  'OGR_VRT',
  'GTI',
  'WMS',
  'WMTS',
  'WCS',
  'WFS',
  'OAPIF',
  'OGCAPI',
  'STACIT',
  'STACTA',
  'EEDA',
  'EEDAI',
  'DAAS',
  'PLMOSAIC',
  'PLSCENES',
  'NGW',
  'CSW',
  'Elasticsearch',
  'Carto',
  'AmigoCloud',
  'HTTP',
] as const;

type Gdal = typeof import('gdal-async');

let loading: Promise<Gdal> | null = null;

export function loadGdalHardened(): Promise<Gdal> {
  loading ??= (async () => {
    const previous = process.env['GDAL_SKIP'];
    const merged = new Set([
      ...(previous ?? '').split(/[\s,]+/).filter(Boolean),
      ...GDAL_SKIPPED_DRIVERS,
    ]);
    process.env['GDAL_SKIP'] = [...merged].join(' ');
    try {
      const mod = await import('gdal-async');
      return ((mod as unknown as { default?: Gdal }).default ?? mod) as Gdal;
    } finally {
      if (previous === undefined) delete process.env['GDAL_SKIP'];
      else process.env['GDAL_SKIP'] = previous;
    }
  })();
  // A failed load (missing prebuild) may be retried later.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** True when GDAL can open `name` in this process (for tests and health). */
export function gdalHasDriver(gdal: Gdal, name: string): boolean {
  try {
    return !!gdal.drivers.get(name);
  } catch {
    return false;
  }
}
