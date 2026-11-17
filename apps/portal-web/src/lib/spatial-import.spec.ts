// SPDX-License-Identifier: AGPL-3.0-or-later
import { detectFormat } from './spatial-import';

describe('detectFormat', () => {
  it('sends geopackage and kmz to the server parser, not the browser', () => {
    expect(detectFormat('sectors.gpkg')).toBe('gpkg');
    expect(detectFormat('places.kmz')).toBe('kmz');
    expect(detectFormat('parcels.zip')).toBe('shapefile-zip');
    expect(detectFormat('county.gdb.zip')).toBe('fgdb');
    expect(detectFormat('blocks.geojson')).toBe('geojson');
  });
});
