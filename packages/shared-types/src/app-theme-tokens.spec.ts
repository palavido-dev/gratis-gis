// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  APP_THEMES,
  applyAppThemeTokens,
  isSafeAppThemeToken,
  unsafeAppThemeTokenKeys,
} from './app-themes';

describe('isSafeAppThemeToken', () => {
  it('accepts every built-in preset token', () => {
    for (const theme of Object.values(APP_THEMES)) {
      expect(unsafeAppThemeTokenKeys(theme.tokens)).toEqual([]);
    }
  });

  it('refuses keys that are not --app-* custom properties', () => {
    expect(isSafeAppThemeToken('display', 'none')).toBe(false);
    expect(isSafeAppThemeToken('background-image', 'none')).toBe(false);
    expect(isSafeAppThemeToken('--other', '1')).toBe(false);
  });

  it('refuses values that fetch or break out of their property', () => {
    expect(
      isSafeAppThemeToken('--app-surface-0', '0 0% 100%), url(https://x.example/p.gif'),
    ).toBe(false);
    expect(isSafeAppThemeToken('--app-font', 'url(https://x.example/f.woff)')).toBe(false);
    expect(isSafeAppThemeToken('--app-font', 'image-set("a.png" 1x)')).toBe(false);
    expect(isSafeAppThemeToken('--app-font', '\\75rl(x)')).toBe(false);
    expect(isSafeAppThemeToken('--app-radius', '1px; color: red')).toBe(false);
    expect(isSafeAppThemeToken('--app-radius', 4)).toBe(false);
  });

  it('accepts plain colors, lengths and shadows', () => {
    expect(isSafeAppThemeToken('--app-accent', '239 84% 67%')).toBe(true);
    expect(isSafeAppThemeToken('--app-radius', '0.5rem')).toBe(true);
    expect(
      isSafeAppThemeToken('--app-shadow-card', '0 1px 2px rgba(0, 0, 0, 0.1)'),
    ).toBe(true);
  });
});

describe('applyAppThemeTokens', () => {
  it('sets only the safe tokens', () => {
    const set: Record<string, string> = {};
    const el = { style: { setProperty: (k: string, v: string) => { set[k] = v; } } };
    applyAppThemeTokens(el, {
      '--app-accent': '239 84% 67%',
      '--app-surface-0': '0 0% 100%), url(https://x.example/p.gif',
      display: 'none',
    });
    expect(set).toEqual({ '--app-accent': '239 84% 67%' });
  });
});
