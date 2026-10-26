// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
} from './format';

describe('i18n format helpers (#162 Phase 3)', () => {
  it('formats numbers with locale grouping', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 'de')).toBe('1.234,5');
  });

  it('formats dates in the requested locale', () => {
    const iso = '2026-06-15T12:00:00.000Z';
    const en = formatDate(iso, 'en', { dateStyle: 'medium', timeZone: 'UTC' });
    const de = formatDate(iso, 'de', { dateStyle: 'medium', timeZone: 'UTC' });
    expect(en).toMatch(/Jun/);
    // de-DE medium is numeric (15.06.2026), not month-name.
    expect(de).toMatch(/15\.06\.2026|15\.6\.2026/);
  });

  it('formats relative time in the requested locale', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
    const en = formatRelativeTime(threeDaysAgo, 'en');
    const es = formatRelativeTime(threeDaysAgo, 'es');
    expect(en.toLowerCase()).toMatch(/day/);
    expect(es.toLowerCase()).toMatch(/d[ií]a/);
  });
});
