// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { mergeFolderChildIds } from './folder-child-ids';

describe('mergeFolderChildIds', () => {
  it('keeps ids the viewer cannot see or that sit in the trash', () => {
    expect(mergeFolderChildIds(['P', 'Q', 'R'], ['Q', 'R'], false)).toEqual([
      'P',
      'Q',
      'R',
    ]);
  });

  it('appends ids the server shows that the page did not know', () => {
    expect(mergeFolderChildIds(['A'], ['A', 'B'], false)).toEqual(['A', 'B']);
  });

  it('never folds smart query results into the saved manual list', () => {
    expect(mergeFolderChildIds(['A', 'B'], ['X', 'Y', 'Z'], true)).toEqual([
      'A',
      'B',
    ]);
  });
});
