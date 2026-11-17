// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { cssUrl } from './css-url';

describe('cssUrl', () => {
  it('quotes a plain URL', () => {
    expect(cssUrl('https://example.test/hero.png')).toBe(
      'url("https://example.test/hero.png")',
    );
  });

  it('keeps a closing paren and semicolon inside the string', () => {
    const out = cssUrl('x);position:fixed;background:url(https://evil.test/a.png');
    expect(out.startsWith('url("')).toBe(true);
    expect(out.endsWith('")')).toBe(true);
    // The only unescaped double quotes are the two that wrap the value.
    expect(out.slice(5, -2)).not.toMatch(/(^|[^\\])"/);
  });

  it('escapes a double quote and a newline', () => {
    expect(cssUrl('a"b\nc')).toBe('url("a\\"b\\nc")');
  });
});
