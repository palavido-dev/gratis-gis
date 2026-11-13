// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { childLayersOf } from './field-child-layers';

const trees = { id: 'trees', geometryType: 'point' };
const hydrants = { id: 'hydrants', geometryType: 'point' };
const inspections = {
  id: 'inspections',
  geometryType: null,
  parentLayerId: 'trees',
  parentFkColumn: 'tree_id',
};

describe('childLayersOf', () => {
  it('offers a related table only under the layer it belongs to', () => {
    const layers = [trees, hydrants, inspections];
    expect(childLayersOf(layers, 'trees').map((l) => l.id)).toEqual(['inspections']);
    expect(childLayersOf(layers, 'hydrants')).toEqual([]);
  });

  it('keeps a legacy child with no parentLayerId when there is one spatial layer', () => {
    const legacy = { id: 'visits', geometryType: null, parentFkColumn: 'site_id' };
    expect(childLayersOf([trees, legacy], 'trees').map((l) => l.id)).toEqual(['visits']);
  });

  it('does not guess a parent for a legacy child among several spatial layers', () => {
    const legacy = { id: 'visits', geometryType: null, parentFkColumn: 'site_id' };
    expect(childLayersOf([trees, hydrants, legacy], 'hydrants')).toEqual([]);
  });

  it('never lists the layer itself or a layer without a key column', () => {
    const self = { ...trees, parentFkColumn: 'x', parentLayerId: 'trees' };
    expect(childLayersOf([self, hydrants], 'trees')).toEqual([]);
  });
});
