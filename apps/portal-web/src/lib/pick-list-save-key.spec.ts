// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PickListData } from '@gratis-gis/shared-types';
import { pickListSaveKey } from './pick-list-save-key';

const list = (entries: PickListData['entries'], note?: string): PickListData =>
  ({ version: 3, entries, ...(note !== undefined ? { note } : {}) }) as PickListData;

describe('pickListSaveKey', () => {
  it('is equal for a fresh copy of the same list', () => {
    const a = list([{ code: 'a', label: 'A' }]);
    const b = { ...a, entries: a.entries.slice() };
    expect(pickListSaveKey(b)).toBe(pickListSaveKey(a));
  });

  it('ignores whitespace that save trims', () => {
    expect(pickListSaveKey(list([{ code: ' a ', label: 'A ' }]))).toBe(
      pickListSaveKey(list([{ code: 'a', label: 'A' }])),
    );
  });

  it('changes when an entry or the note changes', () => {
    const base = pickListSaveKey(list([{ code: 'a', label: 'A' }]));
    expect(pickListSaveKey(list([{ code: 'a', label: 'B' }]))).not.toBe(base);
    expect(pickListSaveKey(list([{ code: 'a', label: 'A' }], 'n'))).not.toBe(base);
  });
});
