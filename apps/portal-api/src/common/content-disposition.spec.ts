// SPDX-License-Identifier: AGPL-3.0-or-later
import { validateHeaderValue } from 'node:http';

import { contentDisposition } from './content-disposition.js';

/**
 * File names with a character above U+00FF used to make Node throw
 * ERR_INVALID_CHAR when the header was set, so every download of
 * such a file answered 500.
 */
describe('contentDisposition', () => {
  it.each([
    'Screenshot 2026-11-11 at 9.41.00 AM.png',
    '报告.pdf',
    'Карта.pdf',
    'site \u2013 north.jpg',
    'pin \u{1F4CD}.png',
  ])('is a valid header value for %s and carries the real name', (name) => {
    const value = contentDisposition('attachment', name);
    expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();
    const star = /filename\*=UTF-8''(.+)$/.exec(value)![1]!;
    expect(decodeURIComponent(star)).toBe(name);
  });

  it('keeps a plain ASCII name readable and strips quotes and line breaks', () => {
    expect(contentDisposition('inline', 'a "b"\r\n.png')).toBe(
      `inline; filename="a b.png"; filename*=UTF-8''a%20%22b%22.png`,
    );
  });

  it('falls back to a generic name when nothing printable is left', () => {
    expect(contentDisposition('attachment', '')).toMatch(/^attachment; filename="download";/);
  });
});
