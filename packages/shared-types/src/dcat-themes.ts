// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Aardvark / OpenGeoMetadata `dcat_theme_sm` vocabulary.
 *
 * Twenty-one controlled theme labels used by GeoBlacklight and
 * library catalogues. GratisGIS stores matching strings in
 * `item.tags` so no migration is required; free-form tags that are
 * not in this set stay keywords.
 *
 * Source: https://opengeometadata.org/ogm-aardvark/#theme
 */

export const ITEM_THEMES = [
  'Agriculture',
  'Biology',
  'Boundaries',
  'Climate',
  'Economy',
  'Elevation',
  'Environment',
  'Events',
  'Geology',
  'Health',
  'Imagery',
  'Inland Waters',
  'Land Cover',
  'Location',
  'Military',
  'Oceans',
  'Property',
  'Society',
  'Structure',
  'Transportation',
  'Utilities',
] as const;

export type ItemTheme = (typeof ITEM_THEMES)[number];

const THEME_SET = new Set<string>(ITEM_THEMES);

export function isItemTheme(value: string): value is ItemTheme {
  return THEME_SET.has(value);
}

/** Themes present in a tags array (order follows ITEM_THEMES). */
export function themesFromTags(tags: string[] | null | undefined): ItemTheme[] {
  if (!tags || tags.length === 0) return [];
  const present = new Set(tags.filter(isItemTheme));
  return ITEM_THEMES.filter((t) => present.has(t));
}

/** Free-form keywords: tags that are not curated themes. */
export function keywordsFromTags(
  tags: string[] | null | undefined,
): string[] {
  if (!tags || tags.length === 0) return [];
  return tags.filter((t) => !isItemTheme(t));
}

/**
 * Merge theme picks with free-form keywords for persistence.
 * Themes come first (stable ITEM_THEMES order), then keywords.
 */
export function mergeThemesAndKeywords(
  themes: readonly ItemTheme[],
  keywords: readonly string[],
): string[] {
  const themeSet = new Set(themes.filter(isItemTheme));
  const orderedThemes = ITEM_THEMES.filter((t) => themeSet.has(t));
  const cleanKeywords = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && !isItemTheme(k));
  // Dedupe keywords case-sensitively while preserving order.
  const seen = new Set<string>();
  const uniqueKeywords: string[] = [];
  for (const k of cleanKeywords) {
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueKeywords.push(k);
  }
  return [...orderedThemes, ...uniqueKeywords];
}
