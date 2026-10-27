// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ITEM_THEMES,
  isItemTheme,
  keywordsFromTags,
  mergeThemesAndKeywords,
  themesFromTags,
} from './dcat-themes.js';

describe('dcat-themes', () => {
  it('exposes 21 Aardvark theme values', () => {
    expect(ITEM_THEMES).toHaveLength(21);
    expect(isItemTheme('Boundaries')).toBe(true);
    expect(isItemTheme('parcels')).toBe(false);
  });

  it('splits tags into themes and keywords', () => {
    const tags = ['parcels', 'Boundaries', 'Environment', 'campus'];
    expect(themesFromTags(tags)).toEqual(['Boundaries', 'Environment']);
    expect(keywordsFromTags(tags)).toEqual(['parcels', 'campus']);
  });

  it('merges themes and keywords for persistence', () => {
    expect(
      mergeThemesAndKeywords(['Environment', 'Boundaries'], ['campus', 'Boundaries']),
    ).toEqual(['Boundaries', 'Environment', 'campus']);
  });
});
