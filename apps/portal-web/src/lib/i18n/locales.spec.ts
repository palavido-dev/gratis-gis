// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pins the `completeness` number each locale advertises to what its
 * catalog actually translates.
 *
 * Nothing else ever recomputes that number, and a key that merely
 * exists is not a translation: the catalogs carried hundreds of
 * English sentences copied as-is while claiming 100. A value that
 * equals the English one and has four or more words counts as
 * untranslated; shorter identical values are cognates. When the field arc
 * landed nine new English sections the four seeded catalogs kept
 * saying 80 while covering about 63 percent of the keys, and the
 * comment beside them still said "every key". A number nobody checks
 * drifts in exactly one direction, so this makes the drift a failing
 * test rather than a stale claim.
 *
 * The check is a floor, not an equality: adding English keys may
 * lower a locale below its advertised figure (fail, so the figure gets
 * lowered or the keys translated), while translating more keys never
 * fails anything. Raise the figure by hand when a locale earns it.
 */
import { LOCALES } from './locales';
import { en } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { de } from './messages/de';
import { ptBR } from './messages/pt-BR';

const CATALOGS: Record<string, unknown> = { en, es, fr, de, 'pt-BR': ptBR };

/** Every dot path in the catalog that ends at a string, with its value. */
function leaves(
  node: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === 'string') {
    out.set(prefix, node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    leaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** True when `value` is a real translation of `english`. */
function isTranslated(value: string, english: string): boolean {
  if (value !== english) return true;
  return english.trim().split(/\s+/).length < 4;
}

/** Every dot path in the catalog that ends at a string. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  if (!node || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out.push(...leafKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

describe('isTranslated', () => {
  it('counts a copied English sentence as untranslated', () => {
    expect(isTranslated('Click a cell to edit it.', 'Click a cell to edit it.')).toBe(false);
    expect(isTranslated('CSV', 'CSV')).toBe(true);
    expect(isTranslated('Haz clic para editar.', 'Click to edit it now.')).toBe(true);
  });
});

describe('locale completeness', () => {
  const enKeys = new Set(leafKeys(en));

  it('lists every supported locale exactly once', () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(CATALOGS).sort()).toEqual([...codes].sort());
  });

  it('never lets a locale define a key English does not', () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      const extra = leafKeys(catalog).filter((k) => !enKeys.has(k));
      expect({ code, extra }).toEqual({ code, extra: [] });
    }
  });

  it.each(LOCALES.map((l) => [l.code, l.completeness] as const))(
    '%s covers at least its declared %d percent of the English keys',
    (code, declared) => {
      const english = leaves(en);
      const catalog = leaves(CATALOGS[code]);
      let covered = 0;
      for (const [key, value] of english) {
        const local = catalog.get(key);
        if (local === undefined) continue;
        // English is the source, so its own values count as written.
        if (code === 'en' || isTranslated(local, value)) covered += 1;
      }
      const actual = Math.floor((covered / english.size) * 100);
      expect(actual).toBeGreaterThanOrEqual(declared);
    },
  );
});
