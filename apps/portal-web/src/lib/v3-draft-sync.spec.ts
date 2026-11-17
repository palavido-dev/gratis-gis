// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DataLayerDataV3, DataLayerSublayer } from '@gratis-gis/shared-types';
import { withServerOwnedFields } from './v3-draft-sync';

function layer(over: Partial<DataLayerSublayer>): DataLayerSublayer {
  return {
    id: 'layer-1',
    label: 'Parcels',
    name: 'parcels',
    geometryType: 'polygon',
    fields: [],
    editingEnabled: true,
    attachmentsEnabled: false,
    ...over,
  } as DataLayerSublayer;
}

const data = (...layers: DataLayerSublayer[]): DataLayerDataV3 =>
  ({ version: 3, storageType: 'postgis', layers }) as DataLayerDataV3;

describe('withServerOwnedFields', () => {
  it('takes counts, extent and provenance from the server, keeps schema edits', () => {
    const draft = data(layer({ label: 'Edited label', featureCount: 0 }));
    const server = data(
      layer({
        featureCount: 1234,
        bbox: [0, 0, 1, 1],
        source: { fileName: 'x.geojson' } as NonNullable<DataLayerSublayer['source']>,
      }),
    );
    const out = withServerOwnedFields(draft, server);
    expect(out.layers[0]).toMatchObject({
      label: 'Edited label',
      featureCount: 1234,
      bbox: [0, 0, 1, 1],
      source: { fileName: 'x.geojson' },
    });
  });

  it('drops a conflict list the server no longer has', () => {
    const draft = data(layer({ syncConflicts: [{} as never] }));
    const out = withServerOwnedFields(draft, data(layer({})));
    expect('syncConflicts' in out.layers[0]!).toBe(false);
  });

  it('leaves unsaved new layers alone and returns the same object when nothing differs', () => {
    const draft = data(layer({ featureCount: 3 }), layer({ id: 'layer-2' }));
    expect(withServerOwnedFields(draft, data(layer({ featureCount: 3 })))).toBe(draft);
  });
});
