// SPDX-License-Identifier: AGPL-3.0-or-later
// A timezone west of UTC, where a date-only string read as UTC lands
// on the previous day. Node applies a TZ change at runtime.
process.env.TZ = 'America/Los_Angeles';

import type { Question } from '@gratis-gis/form-schema';
import type { PickListData } from '@gratis-gis/shared-types';

import {
  formatTemporalAnswer,
  labelForChoice,
  mergeUserNames,
} from './form-answer-format';

describe('labelForChoice', () => {
  const selectOne = {
    id: 'q1',
    type: 'select-one',
    label: 'Priority',
    choices: [
      { value: 'hi', label: 'High priority' },
      { value: 'lo', label: 'Low priority' },
    ],
  } as unknown as Question;

  it('reads inline choices by value', () => {
    expect(labelForChoice(selectOne, 'hi', {})).toBe('High priority');
    expect(labelForChoice(selectOne, 'nope', {})).toBeNull();
  });

  it('falls back to the pick list named by pickListId', () => {
    const q = {
      id: 'q2',
      type: 'select-many',
      label: 'Trees',
      choices: [],
      pickListId: 'pl-1',
    } as unknown as Question;
    const lists: Record<string, PickListData> = {
      'pl-1': {
        version: 1,
        entries: [{ code: 'oak', label: 'Coast live oak' }],
      } as unknown as PickListData,
    };
    expect(labelForChoice(q, 'oak', lists)).toBe('Coast live oak');
  });

  it('returns null for questions that are not selects', () => {
    const q = { id: 'q3', type: 'text', label: 'Name' } as unknown as Question;
    expect(labelForChoice(q, 'x', {})).toBeNull();
  });
});

describe('formatTemporalAnswer', () => {
  it('shows a date-only answer on the day that was entered, with no time', () => {
    const out = formatTemporalAnswer('date', '2026-03-05', 'en');
    expect(out).toBe('Mar 5, 2026');
  });

  it('shows a time answer instead of a blank', () => {
    const out = formatTemporalAnswer('time', '14:30', 'en');
    expect(out).toMatch(/2:30\s?PM/);
  });

  it('formats a local datetime as entered', () => {
    const out = formatTemporalAnswer('datetime', '2026-03-05T14:30', 'en');
    expect(out).toMatch(/Mar 5, 2026/);
    expect(out).toMatch(/2:30\s?PM/);
  });

  it('returns unparseable input as typed', () => {
    expect(formatTemporalAnswer('time', 'noonish', 'en')).toBe('noonish');
    expect(formatTemporalAnswer('date', 'someday', 'en')).toBe('someday');
  });
});

describe('mergeUserNames', () => {
  it('caches ids the server did not return so the lookup stops', () => {
    const a = mergeUserNames({}, ['u1'], []);
    expect('u1' in a).toBe(true);
    expect(a['u1']).toBe('u1');
  });

  it('uses the full name, then the username', () => {
    const out = mergeUserNames({}, ['u1', 'u2'], [
      { id: 'u1', fullName: ' Ada Lovelace ', username: 'ada' },
      { id: 'u2', fullName: null, username: 'bob' },
    ]);
    expect(out).toEqual({ u1: 'Ada Lovelace', u2: 'bob' });
  });
});
