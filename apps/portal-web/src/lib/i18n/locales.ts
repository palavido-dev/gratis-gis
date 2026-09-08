// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1: locale list + helpers.
 *
 * The supported locales are kept here as a single list so adding
 * a new one is a one-place change. Phase 1.0 ships English only
 * as the reference catalog; Phase 1.1 will seed Spanish,
 * Portuguese, French, German via machine translation + community
 * review. The user-facing locale switcher (Phase 4) reads this
 * list to populate its menu.
 *
 * Demo telemetry currently shows portal sign-ins from EU + South
 * America hitting the English-only UI; that's the audience the
 * priority locales are picked for.
 */
import type { en as enCatalog } from './messages/en';

/** BCP-47 locale identifier the portal supports. */
export type SupportedLocale =
  | 'en'
  | 'es' // Spanish (Spain + LATAM baseline)
  | 'pt-BR' // Brazilian Portuguese
  | 'fr' // French
  | 'de'; // German

/** Default locale used when nothing else applies. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** Every supported locale plus a human-readable display label and
 *  the native-script name (so a viewer who can't read the portal's
 *  current locale still recognizes their own language). */
export interface LocaleInfo {
  code: SupportedLocale;
  /** Label rendered in the locale switcher. Always in the locale's
   *  own script so a viewer can self-identify. */
  nativeName: string;
  /** English label used by admin / debug surfaces. */
  englishName: string;
  /**
   * Translation completeness as a percentage: the share of English
   * leaf keys this catalog defines. Maintained by hand as a floor,
   * and `locales.spec.ts` fails when a catalog drops below its
   * declared figure, so adding English keys without translating them
   * eventually forces this number down rather than letting it lie.
   */
  completeness: number;
  /**
   * #162 Phase 1.1: when true, the catalog is a machine-translated
   * seed waiting on native-speaker review. The locale picker shows
   * a small "MT" badge so a user knows what to expect and how to
   * help. Flips to false once a native speaker has signed off in a
   * review pass (catalog files carry the review marker explicitly).
   */
  machineTranslated: boolean;
}

export const LOCALES: LocaleInfo[] = [
  {
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    completeness: 100,
    machineTranslated: false,
  },
  // Phase 1.1 seeded these four by machine translation and they still
  // await native-speaker review (the locale picker tags them with an
  // "MT" badge and links to the contributor guide). They covered the
  // whole English catalog when seeded, but sections added since
  // (feature editing, the field runtime's queue, attachments,
  // collect, GPS and offline copy, sign-out, the map and app cards,
  // and this review's additions) exist only in English and fall back
  // to it at runtime. Measured 2026-09-08: each defines 59 percent of
  // the English keys. The figure below is a floor a little under that
  // so a handful of new English keys does not fail the suite; when
  // the gap is translated, raise it.
  {
    code: 'es',
    nativeName: 'Español',
    englishName: 'Spanish',
    completeness: 55,
    machineTranslated: true,
  },
  {
    code: 'pt-BR',
    nativeName: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    completeness: 55,
    machineTranslated: true,
  },
  {
    code: 'fr',
    nativeName: 'Français',
    englishName: 'French',
    completeness: 55,
    machineTranslated: true,
  },
  {
    code: 'de',
    nativeName: 'Deutsch',
    englishName: 'German',
    completeness: 55,
    machineTranslated: true,
  },
];

/**
 * Negotiate a SupportedLocale from a request's Accept-Language
 * header. Falls back to DEFAULT_LOCALE when nothing matches. The
 * regional variant of pt-BR matches "pt" and "pt-BR" both; other
 * languages match by primary subtag.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  // Parse "Accept-Language: en-US,en;q=0.9,fr;q=0.8" into
  // ranked tags. q-values default to 1.0 when omitted; ranges
  // beyond [0, 1] are clamped.
  const ranked = acceptLanguage
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = p.trim().match(/^q=([0-9]*\.?[0-9]+)$/);
        if (m) q = Math.min(1, Math.max(0, Number(m[1])));
      }
      return { tag: (tag ?? '').toLowerCase(), q };
    })
    .filter((r) => r.tag.length > 0 && r.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const r of ranked) {
    if (r.tag === 'pt-br' || r.tag.startsWith('pt')) return 'pt-BR';
    const primary = r.tag.split('-')[0];
    if (primary === 'es') return 'es';
    if (primary === 'fr') return 'fr';
    if (primary === 'de') return 'de';
    if (primary === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

/** Recursively widen the English reference catalog so non-English
 *  catalogs can provide their own translations (different string
 *  literals) for any key without TypeScript rejecting the
 *  mismatched literal types. The structure stays gated by enCatalog:
 *  a non-English catalog can't declare a key the English catalog
 *  doesn't already define. */
type WidenLeaves<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? WidenLeaves<U>[]
    : T extends object
      ? { [K in keyof T]: WidenLeaves<T[K]> }
      : T;

/** Type of the catalog every locale honors. Sourced from the
 *  English catalog with string leaves so translations slot in
 *  without literal-type conflicts. */
export type CatalogShape = WidenLeaves<typeof enCatalog>;
