// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pins the `completeness` number each locale advertises to what its
 * catalog actually contains.
 *
 * The locale picker shows that number to a person deciding whether to
 * switch, and nothing else ever recomputes it. When the field arc
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
      const covered = leafKeys(CATALOGS[code]).filter((k) => enKeys.has(k));
      const actual = Math.floor((covered.length / enKeys.size) * 100);
      expect(actual).toBeGreaterThanOrEqual(declared);
    },
  );
});
