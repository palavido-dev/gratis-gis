// SPDX-License-Identifier: AGPL-3.0-or-later
import { dataLayerScopes } from './feature-oid.js';

describe('dataLayerScopes', () => {
  it('lists one scope per v3 sublayer and table', () => {
    expect(
      dataLayerScopes('i1', { version: 3, layers: [{ id: 'parcels' }, { id: 'owners' }] }),
    ).toEqual(['data_layer:i1:parcels', 'data_layer:i1:owners']);
  });

  it('has none for legacy or malformed data', () => {
    expect(dataLayerScopes('i1', { version: 2, layers: [{ id: 'x' }] })).toEqual([]);
    expect(dataLayerScopes('i1', null)).toEqual([]);
    expect(dataLayerScopes('i1', { version: 3, layers: [{}, { id: '' }, { id: 7 }] })).toEqual([]);
  });
});
