// SPDX-License-Identifier: AGPL-3.0-or-later
import { changedProperties } from './changed-properties';

describe('changedProperties', () => {
  it('returns only the keys the user changed', () => {
    expect(
      changedProperties(
        { status: 'open', notes: 'a', tags: ['x'], _global_id: 'g' },
        { status: 'open', notes: 'b', tags: ['x'], _global_id: 'g' },
      ),
    ).toEqual({ notes: 'b' });
  });

  it('treats null and missing as the same, and arrays by content', () => {
    expect(changedProperties({ a: null }, { a: undefined, b: null })).toEqual({});
    expect(changedProperties({ tags: ['x'] }, { tags: ['x', 'y'] })).toEqual({ tags: ['x', 'y'] });
  });

  it('sends a cleared value', () => {
    expect(changedProperties({ notes: 'a' }, { notes: null })).toEqual({ notes: null });
  });
});
