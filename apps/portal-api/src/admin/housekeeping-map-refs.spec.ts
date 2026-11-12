// SPDX-License-Identifier: AGPL-3.0-or-later
import { collectMapItemRefs } from './housekeeping.service.js';

describe('collectMapItemRefs', () => {
  it('keeps UUID item ids and drops anything else', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(
      collectMapItemRefs({
        layers: [
          { source: { kind: 'data-layer', itemId: id } },
          { source: { kind: 'data-layer', itemId: 'parcels' } },
          { source: { kind: 'arcgis-rest', sourceItemId: 42 } },
        ],
      }),
    ).toEqual([id]);
  });
});
