// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1: portable lookup + interpolation runtime.
 *
 * Phase 1.0 ships a tiny vanilla i18n core rather than dragging in
 * a heavy library (next-intl, react-intl, FormatJS). The Phase 1.0
 * surface is intentionally small so the i18n-readiness sweep that
 * lands in Phase 1.1 can replace this with the full machinery
 * without breaking the call sites: every component just imports
 * `t()` and a key, and the runtime behind it is swappable.
 *
 * The Phase 1.1 swap will likely land next-intl (the current
 * App-Router-friendly default) and a translation platform
 * (Weblate self-hosted, per the roadmap). Phase 1.0 just gets
 * the keys defined and the lookup wired up.
 *
 * `t(key, params?, locale?)`:
 *   - key: dot-separated path into the catalog ("nav.signIn").
 *     Missing keys fall back to the key itself (so a typo
 *     surfaces as the literal token "nav.signIn" rather than an
 *     empty string).
 *   - params: optional record. `{name}` placeholders in the
 *     value are replaced; ICU plural cases (`{count, plural, ...}`)
 *     are handled for the common cardinal categories.
 *   - locale: explicit locale override. When omitted, the
 *     server-side caller passes the negotiated locale through
 *     the React context (Phase 1.1 wires this up). For Phase
 *     1.0 the helper falls back to English.
 */
import { DEFAULT_LOCALE, type SupportedLocale, type CatalogShape } from './locales';
import { en } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { de } from './messages/de';
import { ptBR } from './messages/pt-BR';

/**
 * #162 Phase 1.1: registry of every locale's catalog.
 *
 * The non-English catalogs ship as partial dictionaries: only the
 * keys actively wired into the UI today are translated, and any
 * other lookup falls back to the English catalog. That keeps the
 * translation surface honest: a half-translated locale renders
 * the English string for unwired keys rather than displaying the
 * raw key as a placeholder.
 */
const CATALOGS: Record<SupportedLocale, Partial<CatalogShape>> = {
  en,
  es,
  'pt-BR': ptBR,
  fr,
  de,
};

/**
 * A `t` already bound to a locale, as `useT()` returns. Library
 * modules that run outside React (export helpers, layer builders)
 * take one of these from their caller instead of importing the hook,
 * so the string still resolves in the viewer's locale.
 */
export type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Look up `key` in the catalog for `locale`, falling back to the
 * English catalog when the locale catalog doesn't define it. ICU
 * placeholders + simple plurals are interpolated using `params`.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const fromLocale = lookup(CATALOGS[locale] as Record<string, unknown>, key);
  const fallback = lookup(CATALOGS[DEFAULT_LOCALE] as Record<string, unknown>, key);
  const value = fromLocale ?? fallback ?? key;
  return interpolate(value, params);
}

/**
 * Walk a dot-separated key into a nested object. Returns null
 * when any segment doesn't exist.
 */
function lookup(
  catalog: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!catalog) return null;
  const segments = key.split('.');
  let cursor: unknown = catalog;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return typeof cursor === 'string' ? cursor : null;
}

/**
 * Minimal ICU MessageFormat support: `{name}` placeholders and
 * `{count, plural, one {...} other {...}}` cardinal plurals.
 * Other selectors (select, ordinal, gender) land in Phase 1.1
 * with the full library swap.
 */
function interpolate(
  raw: string,
  params?: Record<string, string | number>,
): string {
  if (!params || Object.keys(params).length === 0) {
    // Still handle bare `#` in plural bodies that callers happen
    // to pass through.
    return raw;
  }
  // Plural form first: `{name, plural, one {...} other {...}}`.
  let out = raw.replace(
    /\{(\w+),\s*plural,\s*([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
    (_match, name: string, body: string) => {
      const value = params[name];
      const n = typeof value === 'number' ? value : Number(value);
      const cases = parsePluralBody(body);
      const pickKey = pluralCaseFor(n);
      const chosen = cases[pickKey] ?? cases.other ?? '';
      return chosen.replace(/#/g, String(n));
    },
  );
  // Simple `{name}` placeholders next.
  out = out.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name];
    return v === undefined ? `{${name}}` : String(v);
  });
  return out;
}

function parsePluralBody(body: string): Record<string, string> {
  // `one {a # b} other {x #}`: pull each `<key> { ... }` pair.
  const out: Record<string, string> = {};
  const re = /(\w+)\s*\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function pluralCaseFor(n: number): 'zero' | 'one' | 'two' | 'few' | 'many' | 'other' {
  // English-default Cardinal: one when |n| == 1, other otherwise.
  // Phase 1.1 will switch to Intl.PluralRules per-locale; the
  // current rule keeps Phase 1.0 self-contained.
  return Math.abs(n) === 1 ? 'one' : 'other';
}

export { DEFAULT_LOCALE };
export type { SupportedLocale };
