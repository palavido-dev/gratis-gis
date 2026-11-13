// SPDX-License-Identifier: AGPL-3.0-or-later
import { printLocale, printTimeZone } from './print-request-context';

describe('print request context', () => {
  it('keeps a real IANA zone and drops anything else', () => {
    expect(printTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(printTimeZone('Not/AZone')).toBeNull();
    expect(printTimeZone('')).toBeNull();
    expect(printTimeZone(undefined)).toBeNull();
  });

  it('prints the requester\'s local date, not the server\'s', () => {
    const at = new Date('2026-11-12T00:30:00Z');
    const tz = printTimeZone('America/Los_Angeles')!;
    const text = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeZone: tz,
    }).format(at);
    expect(text).toBe('Nov 11, 2026');
  });

  it('accepts only shipped locales', () => {
    expect(printLocale('de')).toBe('de');
    expect(printLocale('pt-BR')).toBe('pt-BR');
    expect(printLocale('xx')).toBe('en');
    expect(printLocale(undefined)).toBe('en');
  });
});
