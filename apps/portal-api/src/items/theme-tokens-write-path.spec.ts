// SPDX-License-Identifier: AGPL-3.0-or-later
import { stripUnsafeThemeTokens } from './items.service.js';

/**
 * Theme tokens are set as CSS custom properties on the root of every
 * app that uses the theme. Create and update strip any token that is
 * not a safe `--app-*` value before the data is stored.
 */
describe('stripUnsafeThemeTokens', () => {
  it('drops real CSS properties and values that load a URL', () => {
    const out = stripUnsafeThemeTokens('theme', {
      version: 1,
      swatch: '#fff',
      tokens: {
        '--app-accent': '239 84% 67%',
        'background-image': 'url(https://x.example/p.gif)',
        '--app-surface-0': '0 0% 100%), url(https://x.example/p.gif',
        display: 'none',
      },
    });
    expect(out).toEqual({
      version: 1,
      swatch: '#fff',
      tokens: { '--app-accent': '239 84% 67%' },
    });
  });

  it('leaves a clean theme and other item types alone', () => {
    const clean = { version: 1, tokens: { '--app-radius': '0.5rem' } };
    expect(stripUnsafeThemeTokens('theme', clean)).toBe(clean);
    const other = { tokens: { display: 'none' } };
    expect(stripUnsafeThemeTokens('map', other)).toBe(other);
  });
});
