// SPDX-License-Identifier: AGPL-3.0-or-later
import { toTreeOrder } from './layer-tree-order';

const leaf = (id: string, groupId?: string) => ({
  id,
  source: { kind: 'data-layer' },
  ...(groupId ? { groupId } : {}),
});
const group = (id: string, groupId?: string) => ({
  id,
  source: { kind: 'group' },
  ...(groupId ? { groupId } : {}),
});
const ids = (ls: Array<{ id: string }>) => ls.map((l) => l.id).join(',');

describe('toTreeOrder', () => {
  it('keeps a moved group header together with its children', () => {
    // The header was spliced above A on its own; B still sat below A.
    expect(ids(toTreeOrder([group('G'), leaf('A'), leaf('B', 'G'), leaf('C')]))).toBe(
      'G,B,A,C',
    );
  });

  it('nests groups depth first and keeps child order', () => {
    const out = toTreeOrder([
      leaf('X', 'G2'),
      group('G'),
      group('G2', 'G'),
      leaf('Y', 'G'),
      leaf('Z'),
    ]);
    expect(ids(out)).toBe('G,G2,X,Y,Z');
  });

  it('treats a dangling groupId as a root and survives a cycle', () => {
    expect(ids(toTreeOrder([leaf('A', 'gone'), leaf('B')]))).toBe('A,B');
    const out = toTreeOrder([group('P', 'Q'), group('Q', 'P'), leaf('L')]);
    expect(ids(out).split(',').sort()).toEqual(['L', 'P', 'Q']);
  });
});
