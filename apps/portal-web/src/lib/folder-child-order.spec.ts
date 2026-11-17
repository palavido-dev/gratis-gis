// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { orderFolderChildren } from './folder-child-order';

const rows = [
  { id: 'c', type: 'map', title: 'Charlie' },
  { id: 'f', type: 'folder', title: 'Zulu folder' },
  { id: 'a', type: 'map', title: 'alpha' },
];

describe('orderFolderChildren', () => {
  it('A to Z puts subfolders first, then titles ignoring case', () => {
    expect(orderFolderChildren(rows, 'az', ['c', 'f', 'a']).map((r) => r.id)).toEqual([
      'f',
      'a',
      'c',
    ]);
  });

  it('Custom shows the saved drag order', () => {
    expect(orderFolderChildren(rows, 'custom', ['c', 'a', 'f']).map((r) => r.id)).toEqual([
      'c',
      'a',
      'f',
    ]);
  });

  it('Custom puts a child missing from the saved order last', () => {
    expect(orderFolderChildren(rows, 'custom', ['a', 'c']).map((r) => r.id)).toEqual([
      'a',
      'c',
      'f',
    ]);
  });
});
