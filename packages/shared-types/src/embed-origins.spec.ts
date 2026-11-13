// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeEmbedOrigin, normalizeEmbedOrigins } from './embed-origins';

describe('normalizeEmbedOrigin', () => {
  it('accepts bare origins and subdomain wildcards', () => {
    expect(normalizeEmbedOrigin(' https://Example.org/ ')).toBe('https://example.org');
    expect(normalizeEmbedOrigin('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    expect(normalizeEmbedOrigin('https://*.arcgis.com')).toBe('https://*.arcgis.com');
  });

  it('refuses anything that is not a bare origin', () => {
    for (const bad of [
      '*',
      'https://*',
      'example.org',
      'ftp://example.org',
      'https://example.org/dash',
      'https://example.org?x=1',
      'https://user@example.org',
      "https://example.org; script-src 'unsafe-inline'",
      'https://a.org https://b.org',
      'https://example.org:70000',
      "'self'",
    ]) {
      expect(normalizeEmbedOrigin(bad)).toBeNull();
    }
  });
});

describe('normalizeEmbedOrigins', () => {
  it('drops blanks and duplicates and reports bad entries', () => {
    expect(
      normalizeEmbedOrigins(['https://a.org', '', 'https://A.org/', 'nope']),
    ).toEqual({ origins: ['https://a.org'], invalid: ['nope'] });
  });
});
