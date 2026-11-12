// SPDX-License-Identifier: AGPL-3.0-or-later
import { dataLayerSublayers } from './data-layer-sublayers';

describe('dataLayerSublayers', () => {
  it('uses _layers from the lite list when present', () => {
    const layers = [{ id: 'a', label: 'A', geometryType: 'Point' }];
    expect(dataLayerSublayers({ _layers: layers, data: {} })).toBe(layers);
  });

  it('reads a v3 blob when the row has no _layers (folder contents)', () => {
    expect(
      dataLayerSublayers({
        data: {
          version: 3,
          layers: [
            { id: 'parcels', label: 'Parcels', geometryType: 'Polygon' },
            { id: 'notes', geometryType: null },
            null,
            { label: 'no id' },
          ],
        },
      }),
    ).toEqual([
      { id: 'parcels', label: 'Parcels', geometryType: 'Polygon' },
      { id: 'notes', label: 'notes', geometryType: null },
    ]);
  });

  it('returns nothing for a legacy single-table layer', () => {
    expect(dataLayerSublayers({ data: { storageType: 'postgis' } })).toEqual([]);
    expect(dataLayerSublayers({})).toEqual([]);
  });
});
