// SPDX-License-Identifier: AGPL-3.0-or-later
import { readV3Layers } from './read-v3-layers.js';

/**
 * Pins the one reader's behaviour on every input where the five
 * former copies disagreed, so the consolidation cannot quietly pick a
 * different answer for one of its callers.
 */
describe('readV3Layers', () => {
  it('narrows a v3 payload to ids, geometry, fields, searchable flags and parentFkColumn', () => {
    expect(
      readV3Layers({
        version: 3,
        layers: [
          {
            id: 'layer-1',
            geometryType: 'point',
            parentFkColumn: 'inspection_id',
            fields: [
              { name: 'OWNER', type: 'string', searchable: true },
              { name: 'NOTES', type: 'string', searchable: false },
              { name: '', type: 'string', searchable: true },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: 'layer-1',
        geometryType: 'point',
        parentFkColumn: 'inspection_id',
        fields: [
          { name: 'OWNER', type: 'string', searchable: true },
          { name: 'NOTES', type: 'string' },
        ],
      },
    ]);
  });

  it('carries every declared field type through, including multi_select', () => {
    // Two of the former copies coerced anything but number, boolean and
    // date to string, so a searchable multi_select was indexed as text.
    const [layer] = readV3Layers({
      version: 3,
      layers: [
        {
          id: 'a',
          fields: [
            { name: 'n', type: 'number' },
            { name: 'b', type: 'boolean' },
            { name: 'd', type: 'date' },
            { name: 'm', type: 'multi_select' },
            { name: 's', type: 'string' },
            { name: 'x', type: 'nonsense' },
          ],
        },
      ],
    })!;
    expect(layer!.fields!.map((f) => f.type)).toEqual([
      'number',
      'boolean',
      'date',
      'multi_select',
      'string',
      'string',
    ]);
  });

  it('returns null for anything that is not a v3 payload', () => {
    expect(readV3Layers({ version: 2, layers: [] })).toBeNull();
    expect(readV3Layers({ version: '3', layers: [] })).toBeNull();
    expect(readV3Layers(null)).toBeNull();
    expect(readV3Layers('v3')).toBeNull();
  });

  it('returns an empty list, not null, for a v3 payload with no layers array', () => {
    // It IS a v3 item; it just declares nothing. Four copies said null
    // here and one said []; every caller iterates the result, so both
    // produced zero work, but the schema-change detector in
    // items.service branches on null to mean "not v3" and must not.
    expect(readV3Layers({ version: 3 })).toEqual([]);
    expect(readV3Layers({ version: 3, layers: 'nope' })).toEqual([]);
  });

  it('drops layers without a string id and reads a missing geometry as a table', () => {
    expect(
      readV3Layers({
        version: 3,
        layers: [{ id: '' }, { geometryType: 'point' }, null, { id: 'ok' }],
      }),
    ).toEqual([{ id: 'ok', geometryType: null, fields: [] }]);
  });
});
