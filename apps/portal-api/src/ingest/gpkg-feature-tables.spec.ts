// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGdalHardened } from '../common/gdal-load.js';
import { readGpkgFeatureTables } from './gpkg-catalog.js';

describe('readGpkgFeatureTables', () => {
  it('returns null when the catalog cannot be read so layers are kept', () => {
    const allowlist = readGpkgFeatureTables({
      executeSQL() {
        throw new Error('executeSQL is not a function');
      },
    });
    expect(allowlist).toBeNull();
  });

  it('returns the feature table names the catalog listed', () => {
    const allowlist = readGpkgFeatureTables({
      executeSQL() {
        return {
          features: {
            forEach(cb: (row: unknown) => void) {
              cb({ fields: { get: () => 'parcels' } });
              cb({ fields: { get: () => 'roads' } });
            },
          },
        };
      },
    });
    expect(allowlist).toEqual(new Set(['parcels', 'roads']));
  });
});

describe('readGpkgFeatureTables on a real GeoPackage', () => {
  it('keeps a user attribute table and drops one an extension claims', async () => {
    // Loaded the way the service loads it.
    const gdal = await loadGdalHardened();
    const dir = mkdtempSync(join(tmpdir(), 'gg-gpkg-'));
    try {
      const path = join(dir, 't.gpkg');
      const ds = gdal.open(path, 'w', 'GPKG');
      ds.layers.create('rivers', gdal.SpatialReference.fromEPSG(4326), gdal.wkbLineString);
      ds.layers.create('lookup', null, gdal.wkbNone);
      ds.layers.create('nga_style', null, gdal.wkbNone);
      try {
        // gdal-async throws on a statement with no result set, after
        // running it.
        ds.executeSQL(
          'INSERT INTO gpkg_extensions (table_name, column_name, extension_name, definition, scope) ' +
            "VALUES ('nga_style', NULL, 'nga_feature_style', 'x', 'read-write')",
        );
      } catch {
        /* ran; see above */
      }
      const tables = readGpkgFeatureTables(ds);
      ds.close();
      expect(tables).toEqual(new Set(['rivers', 'lookup']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
