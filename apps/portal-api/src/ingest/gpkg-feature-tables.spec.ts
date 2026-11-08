// SPDX-License-Identifier: AGPL-3.0-or-later
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
