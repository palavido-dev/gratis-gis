// SPDX-License-Identifier: AGPL-3.0-or-later
import { toggleLayerVisibility, type GroupVisibilityMemory } from './layer-group-toggle';

const vis = (ls: Array<{ id: string; visible: boolean }>) =>
  Object.fromEntries(ls.map((l) => [l.id, l.visible]));

describe('toggleLayerVisibility', () => {
  const layers = [
    { id: 'g', visible: true },
    { id: 'a', visible: true, groupId: 'g' },
    { id: 'b', visible: false, groupId: 'g' },
    { id: 'c', visible: true, groupId: 'a' },
    { id: 'x', visible: true },
  ];

  it('hides every descendant and restores their own state on show', () => {
    const mem: GroupVisibilityMemory = new Map();
    const off = toggleLayerVisibility(layers, 'g', false, mem);
    expect(vis(off)).toEqual({ g: false, a: false, b: false, c: false, x: true });
    const on = toggleLayerVisibility(off, 'g', true, mem);
    expect(vis(on)).toEqual({ g: true, a: true, b: false, c: true, x: true });
  });

  it('toggles a plain layer on its own', () => {
    const mem: GroupVisibilityMemory = new Map();
    expect(vis(toggleLayerVisibility(layers, 'x', false, mem)).x).toBe(false);
    expect(mem.size).toBe(0);
  });
});
