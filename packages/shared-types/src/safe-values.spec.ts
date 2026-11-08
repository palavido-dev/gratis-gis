// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  findUnsafeMapColors,
  isSafeCssColor,
  safeCssColor,
  safeNavigationUrl,
} from './safe-values';

describe('safeNavigationUrl', () => {
  it.each([
    ['/items/abc?view=run', '/items/abc?view=run'],
    ['  https://example.com/x ', 'https://example.com/x'],
    ['http://example.com', 'http://example.com'],
  ])('accepts %s', (raw, expected) => {
    expect(safeNavigationUrl(raw)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '//evil.example/x',
    '/\\evil.example/x',
    'https://',
    '',
    'items/abc',
  ])('rejects %j', (raw) => {
    expect(safeNavigationUrl(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeNavigationUrl(undefined)).toBeNull();
    expect(safeNavigationUrl(42)).toBeNull();
  });
});

describe('isSafeCssColor', () => {
  it.each([
    '#fff',
    '#6366f1',
    '#6366f180',
    'red',
    'rgba(10, 20, 30, 0.5)',
    'rgb(10 20 30 / 50%)',
    'hsl(200deg 50% 40%)',
  ])('accepts %s', (v) => {
    expect(isSafeCssColor(v)).toBe(true);
  });

  it.each([
    '"/><iframe srcdoc="<script>alert(1)</script>"></iframe><svg x="',
    "red' onload='x",
    'red;background:url(x)',
    'red}body{x',
    'a\\22',
    '',
    'x'.repeat(65),
  ])('rejects %j', (v) => {
    expect(isSafeCssColor(v)).toBe(false);
  });

  it('safeCssColor falls back', () => {
    expect(safeCssColor('"><x', 'currentColor')).toBe('currentColor');
    expect(safeCssColor('#000', 'currentColor')).toBe('#000');
  });
});

describe('findUnsafeMapColors', () => {
  it('finds hostile colors anywhere under layers', () => {
    const bad = '"/><iframe srcdoc="x"></iframe>';
    const data = {
      title: '<b>not a color</b>',
      layers: [
        { style: { point: { color: '#fff', strokeColor: bad } } },
        {
          style: {
            renderer: {
              kind: 'class-breaks',
              colors: ['#000', bad],
              categories: [{ value: "O'Brien <x>", color: '#123' }],
            },
            label: { haloColor: bad },
          },
        },
      ],
    };
    expect(findUnsafeMapColors(data)).toEqual([
      'layers[0].style.point.strokeColor',
      'layers[1].style.renderer.colors[1]',
      'layers[1].style.label.haloColor',
    ]);
  });

  it('ignores operands of an expression under a singular color key', () => {
    const data = {
      layers: [{ style: { color: ['match', ['get', 'k'], "O'Brien", '#f00', '#0f0'] } }],
    };
    expect(findUnsafeMapColors(data)).toEqual([]);
  });

  it('returns nothing for data without layers', () => {
    expect(findUnsafeMapColors(null)).toEqual([]);
    expect(findUnsafeMapColors({ color: '<x>' })).toEqual([]);
  });
});
