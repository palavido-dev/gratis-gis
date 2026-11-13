// SPDX-License-Identifier: AGPL-3.0-or-later
import { splitTableLayers } from './table-layers';

describe('splitTableLayers', () => {
  const layers = [
    { id: 'g', source: { kind: 'group' } },
    { id: 'parcels', groupId: 'g', source: { kind: 'data-layer' } },
    { id: 'owners', groupId: 'g', source: { kind: 'data-layer' } },
    { id: 'roads', source: { kind: 'data-layer' } },
    { id: 'notes', source: { kind: 'data-layer' } },
  ];

  it('moves tables out of the tree, keeping order', () => {
    const tables = new Set(['owners', 'notes']);
    const out = splitTableLayers(layers, (id) => tables.has(id));
    expect(out.tree.map((l) => l.id)).toEqual(['g', 'parcels', 'roads']);
    expect(out.tables.map((l) => l.id)).toEqual(['owners', 'notes']);
  });

  it('never treats a group header as a table', () => {
    const out = splitTableLayers(layers, () => true);
    expect(out.tree.map((l) => l.id)).toEqual(['g']);
    expect(out.tables).toHaveLength(4);
  });
});
