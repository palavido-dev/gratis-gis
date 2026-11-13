// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import {
  dateInputToExpiry,
  expiryToDateInput,
  localDateInputValue,
} from './share-expiry-date';

// Jest's sandbox does not let a spec switch process.env.TZ, so these
// build their moments from local parts. Late evening and just after
// midnight together cover both sides: in any zone other than UTC one
// of them falls on a different UTC calendar day, which is where the
// old `toISOString().slice(0, 10)` went wrong.
describe('share expiry dates', () => {
  it('gives the local calendar day near both ends of the day', () => {
    expect(localDateInputValue(new Date(2026, 3, 30, 23, 30))).toBe('2026-04-30');
    expect(localDateInputValue(new Date(2026, 3, 30, 0, 5))).toBe('2026-04-30');
  });

  it('round trips a custom pick to the same calendar day', () => {
    const now = new Date(2026, 3, 1, 12, 0);
    const iso = dateInputToExpiry('2026-04-30', now);
    expect(iso).not.toBeNull();
    // Stored as local end of day.
    const back = new Date(iso as string);
    expect([back.getFullYear(), back.getMonth(), back.getDate(), back.getHours()]).toEqual([
      2026, 3, 30, 23,
    ]);
    expect(expiryToDateInput(iso)).toBe('2026-04-30');
  });

  it('accepts today in the evening and refuses a day that has passed', () => {
    const now = new Date(2026, 3, 30, 18, 0);
    expect(dateInputToExpiry('2026-04-30', now)).not.toBeNull();
    expect(dateInputToExpiry('2026-04-29', now)).toBeNull();
  });

  it('refuses junk', () => {
    expect(dateInputToExpiry('')).toBeNull();
    expect(dateInputToExpiry('2026-13-45')).toBeNull();
    expect(expiryToDateInput('not a date')).toBe('');
    expect(expiryToDateInput(null)).toBe('');
  });
});
