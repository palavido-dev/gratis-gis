// SPDX-License-Identifier: AGPL-3.0-or-later
import { pluralCaseFor, t } from './index';
import { en } from './messages/en';

describe('plural selection', () => {
  it('uses the rule of each locale', () => {
    expect(pluralCaseFor(0, 'en')).toBe('other');
    expect(pluralCaseFor(1, 'en')).toBe('one');
    // CLDR: French and Portuguese put zero in `one`.
    expect(pluralCaseFor(0, 'fr')).toBe('one');
    expect(pluralCaseFor(0, 'pt-BR')).toBe('one');
    expect(pluralCaseFor(0, 'de')).toBe('other');
    expect(pluralCaseFor(2, 'fr')).toBe('other');
  });

  it('renders zero in the singular for French', () => {
    expect(t('addToFolder.itemCount', { count: 0 }, 'fr')).toBe('0 élément');
    expect(t('addToFolder.itemCount', { count: 0 }, 'en')).toMatch(/^0 items?$/);
    expect(t('addToFolder.itemCount', { count: 0 }, 'en')).not.toBe('0 item');
  });
});

describe('every plural message in every catalog', () => {
  // The runtime's plural parser takes one level of braces inside a
  // branch and no `=N` selectors. A message it cannot parse is shown to
  // the user as raw ICU source, so each one is rendered here with
  // dummy values and must come out with no plural syntax left.
  const locales = ['en', 'es', 'fr', 'de', 'pt-BR'] as const;
  function pluralKeys(node: unknown, prefix: string, out: string[]): string[] {
    if (typeof node === 'string') {
      if (node.includes('plural,')) out.push(prefix);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        pluralKeys(v, prefix ? `${prefix}.${k}` : k, out);
      }
    }
    return out;
  }
  const keys = pluralKeys(en, '', []);

  it('finds the plural messages', () => {
    expect(keys.length).toBeGreaterThan(50);
  });

  it.each(locales)('renders them all in %s', (locale) => {
    const broken: string[] = [];
    for (const key of keys) {
      // Every placeholder the English text names gets a number, so
      // only the plural parse is under test.
      const raw = t(key, undefined, 'en');
      const params: Record<string, number> = {};
      for (const m of raw.matchAll(/\{(\w+)[,}]/g)) params[m[1]!] = 2;
      const out = t(key, params, locale);
      if (out.includes('plural,')) broken.push(key);
    }
    expect(broken).toEqual([]);
  });

  it('puts the schema after the count in the PostGIS table heading', () => {
    expect(
      t('postgisConnectionBuilder.tablesHeading', { count: 3, schema: 'public' }, 'en'),
    ).toBe('3 geometry tables in public');
  });
});
