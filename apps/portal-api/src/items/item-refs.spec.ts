// SPDX-License-Identifier: AGPL-3.0-or-later
import { findUnsafeItemRefs } from './items.service.js';

describe('findUnsafeItemRefs', () => {
  it('passes plain ids, empty values and unrelated keys', () => {
    expect(
      findUnsafeItemRefs({
        operationalLayers: [
          { source: { kind: 'data-layer', itemId: '0b1c2d3e-0000-4000-8000-000000000001', layerKey: 'lyr_a' } },
          { source: { kind: 'postgis-live', serviceItemId: '', tableName: 'public.t' } },
          { url: 'https://example.com/a/../b', title: 'x.y' },
        ],
      }),
    ).toEqual([]);
  });

  it('flags a saved id that would walk to another endpoint', () => {
    expect(
      findUnsafeItemRefs({
        operationalLayers: [{ source: { kind: 'postgis-live', serviceItemId: '../scripts/S/run?x=' } }],
        terrain: { stack: [{ itemId: 'a/b' }] },
        boundaryFilterItemId: 'x#y',
      }),
    ).toEqual([
      'operationalLayers[0].source.serviceItemId',
      'terrain.stack[0].itemId',
      'boundaryFilterItemId',
    ]);
  });
});
