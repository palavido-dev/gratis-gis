// SPDX-License-Identifier: AGPL-3.0-or-later
import { pluralCaseFor, t } from './index';
import { de } from './messages/de';
import { en } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { ptBR } from './messages/pt-BR';
import type { SupportedLocale } from './locales';

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


function stringsWithKeys(
  node: unknown,
  prefix: string,
  out: Array<[string, string]>,
): void {
  if (typeof node === 'string') {
    out.push([prefix, node]);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    stringsWithKeys(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

describe('plural interpolation', () => {
  it('handles =0 cases and placeholders inside a case', () => {
    const key = 'postgisConnectionBuilder.tablesHeading';
    for (const n of [0, 1, 2]) {
      const out = t(key, { count: n, schema: 'public' }, 'en');
      expect(out).not.toContain('plural,');
      expect(out).toContain('public');
    }
    expect(t(key, { count: 0, schema: 'public' }, 'en')).not.toMatch(/^0 /);
  });

  const catalogs: Array<[SupportedLocale, unknown]> = [
    ['en', en],
    ['de', de],
    ['es', es],
    ['fr', fr],
    ['pt-BR', ptBR],
  ];
  it.each(catalogs)('renders every plural string in %s', (locale, catalog) => {
    const entries: Array<[string, string]> = [];
    stringsWithKeys(catalog, '', entries);
    const plural = entries.filter(([, v]) => v.includes('plural,'));
    expect(plural.length).toBeGreaterThan(0);
    for (const [key, raw] of plural) {
      const params: Record<string, string | number> = {};
      for (const m of raw.matchAll(/\{(\w+)[},]/g)) params[m[1]!] = 'x';
      for (const m of raw.matchAll(/\{(\w+),\s*plural,/g)) params[m[1]!] = 2;
      for (const n of [0, 1, 2]) {
        for (const m of raw.matchAll(/\{(\w+),\s*plural,/g)) params[m[1]!] = n;
        const out = t(key, params, locale);
        expect([key, out]).toEqual([key, expect.not.stringContaining('plural,')]);
      }
    }
  });
});
