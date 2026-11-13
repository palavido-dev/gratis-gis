// SPDX-License-Identifier: AGPL-3.0-or-later
import { hiddenLayerIds, showLayerAndParents } from './search-hidden-layers';

const layers = [
  { id: 'g', visible: false },
  { id: 'parcels', visible: true, groupId: 'g' },
  { id: 'zoning', visible: false, groupId: 'g' },
  { id: 'roads', visible: true },
  { id: 'wells', visible: false },
];

describe('hiddenLayerIds', () => {
  it('counts a layer under a hidden group as hidden', () => {
    expect([...hiddenLayerIds(layers)].sort()).toEqual(
      ['g', 'parcels', 'wells', 'zoning'],
    );
  });

  it('survives groups that point at each other', () => {
    const loop = [
      { id: 'a', visible: true, groupId: 'b' },
      { id: 'b', visible: true, groupId: 'a' },
    ];
    expect(hiddenLayerIds(loop).size).toBe(0);
  });
});

describe('showLayerAndParents', () => {
  it('turns on the layer and its group, leaving siblings alone', () => {
    const out = showLayerAndParents(layers, 'zoning');
    const vis = Object.fromEntries(out.map((l) => [l.id, l.visible]));
    expect(vis).toEqual({
      g: true,
      parcels: true,
      zoning: true,
      roads: true,
      wells: false,
    });
  });

  it('returns the same array when nothing changes', () => {
    expect(showLayerAndParents(layers, 'roads')).toBe(layers);
    expect(showLayerAndParents(layers, 'missing')).toBe(layers);
  });
});
