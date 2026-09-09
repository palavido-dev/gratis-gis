// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Adversarial spec for the attribution sanitizer.
 *
 * The negative cases are written as "no executable construct survives"
 * rather than as exact-output assertions wherever the exact output is
 * incidental. Pinning the precise escaping of a payload makes the spec
 * fail on a harmless formatting change and tempts whoever is fixing it
 * to update the expectation instead of reading it, which is how a
 * sanitizer spec quietly stops testing anything.
 *
 * `expectInert` is the shared assertion: whatever comes out, it carries
 * no tag outside the allowlist, no event-handler attribute, and no
 * scheme other than http(s) in an href.
 */

import {
  MAX_ATTRIBUTION_LENGTH,
  sanitizeAttributionHtml,
} from './attribution-html';

/** Every start/end tag name present in the output. */
function tagsIn(html: string): string[] {
  return Array.from(html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)).map((m) =>
    (m[1] as string).toLowerCase(),
  );
}

/** Every href value present in the output. */
function hrefsIn(html: string): string[] {
  return Array.from(html.matchAll(/href="([^"]*)"/g)).map((m) => m[1] as string);
}

const ALLOWED = new Set(['a', 'b', 'strong', 'em', 'i', 'span']);

function expectInert(output: string): void {
  for (const tag of tagsIn(output)) {
    expect(ALLOWED.has(tag)).toBe(true);
  }
  // No event handler can reach the DOM. Checked on the raw output, so
  // an `onerror` smuggled inside an unescaped tag would trip it.
  expect(/<[^>]*\son[a-z]+\s*=/i.test(output)).toBe(false);
  for (const href of hrefsIn(output)) {
    expect(/^https?:\/\/./i.test(href)).toBe(true);
  }
  // Anything that would open a scripting context.
  expect(/<script/i.test(output)).toBe(false);
  expect(/<svg/i.test(output)).toBe(false);
  expect(/<img/i.test(output)).toBe(false);
  expect(/<iframe/i.test(output)).toBe(false);
}

describe('sanitizeAttributionHtml: hostile hrefs', () => {
  const HOSTILE_HREFS = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'javascript\t:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'java\u0000script:alert(1)',
    '\u0001javascript:alert(1)',
    'jav&#x09;ascript:alert(1)',
    'jav&#9;ascript:alert(1)',
    '&#106;avascript:alert(1)',
    '&#x6a;avascript:alert(1)',
    '&#0000106;avascript:alert(1)',
    'javascript&colon;alert(1)',
    'java&Tab;script:alert(1)',
    'java&NewLine;script:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'file:///etc/passwd',
    // Protocol-relative: inherits the page scheme and is an off-site
    // navigation the author did not spell out.
    '//evil.example/x',
    '/relative/path',
    'evil.example',
    'https:/evil.example',
    // A bare scheme is not a destination.
    'https://',
    'http://',
  ];

  it.each(HOSTILE_HREFS)('refuses href %j', (href) => {
    const out = sanitizeAttributionHtml(`<a href="${href}">OSM</a>`);
    expectInert(out);
    // Refused rather than dropped: the anchor is still visible to the
    // author, as escaped text.
    expect(out).toContain('&lt;a');
    expect(out).toContain('OSM');
    // And it is not a link.
    expect(out).not.toMatch(/<a\s/);
  });

  it('refuses a hostile href quoted with single quotes', () => {
    const out = sanitizeAttributionHtml("<a href='javascript:alert(1)'>x</a>");
    expectInert(out);
    expect(out).not.toMatch(/<a\s/);
  });

  it('refuses a hostile href with no quotes at all', () => {
    const out = sanitizeAttributionHtml('<a href=javascript:alert(1)>x</a>');
    expectInert(out);
    expect(out).not.toMatch(/<a\s/);
  });

  it('takes the FIRST of two hrefs, as a browser does', () => {
    // A sanitizer that reads the last occurrence sees only the decoy
    // and emits an anchor whose href the browser resolves to the
    // hostile one.
    const out = sanitizeAttributionHtml(
      '<a href="javascript:alert(1)" href="https://osm.org">x</a>',
    );
    expectInert(out);
    expect(out).not.toMatch(/<a\s/);
  });

  it('refuses an anchor with no href rather than emitting a dead link', () => {
    const out = sanitizeAttributionHtml('<a>OSM</a>');
    expectInert(out);
    expect(out).not.toMatch(/<a\s/);
    expect(out).toContain('OSM');
  });
});

describe('sanitizeAttributionHtml: hostile attributes and elements', () => {
  it('drops onclick from an otherwise valid anchor', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org" onclick="alert(1)">OSM</a>',
    );
    expectInert(out);
    expect(out).toContain('href="https://osm.org"');
    expect(out).not.toContain('onclick');
  });

  it('drops EVERY handler, not every other one (the NamedNodeMap skip)', () => {
    // The CVE is a walk over the live attribute collection that calls
    // removeAttribute by index: removing index 0 shifts index 1 down
    // into the slot already visited, so it is never examined and it
    // survives. Consecutive handlers are the shape that catches it.
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org" onclick="a()" onerror="b()" onmouseover="c()" onfocus="d()">OSM</a>',
    );
    expectInert(out);
    for (const handler of ['onclick', 'onerror', 'onmouseover', 'onfocus']) {
      expect(out).not.toContain(handler);
    }
    expect(out).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('drops a handler that repeats, where a skip-one bug leaves the second', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org" onerror="a()" onerror="b()">OSM</a>',
    );
    expectInert(out);
    expect(out).not.toContain('onerror');
  });

  it('escapes img/onerror', () => {
    const out = sanitizeAttributionHtml('<img src=x onerror=alert(1)>');
    expectInert(out);
    expect(out).toContain('&lt;img');
    expect(out).toContain('onerror'); // visible as text, not as markup
    expect(out).not.toContain('<img');
  });

  it('escapes svg/onload with the slash separator', () => {
    const out = sanitizeAttributionHtml('<svg/onload=alert(1)>');
    expectInert(out);
    expect(out).toContain('&lt;svg');
    expect(out).not.toContain('<svg');
  });

  it('escapes a script element and its contents stay text', () => {
    const out = sanitizeAttributionHtml('<script>alert(1)</script>');
    expectInert(out);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('alert(1)');
    expect(out).toContain('&lt;/script&gt;');
  });

  it('escapes the parser-mode switching elements', () => {
    for (const tag of [
      'noscript',
      'template',
      'style',
      'textarea',
      'title',
      'math',
      'iframe',
      'object',
      'embed',
      'form',
      'base',
    ]) {
      const out = sanitizeAttributionHtml(`<${tag}>x</${tag}>`);
      expectInert(out);
      expect(out).toContain(`&lt;${tag}&gt;`);
    }
  });

  it('handles mixed-case tag names', () => {
    const out = sanitizeAttributionHtml('<ScRiPt>alert(1)</ScRiPt>');
    expectInert(out);
    expect(out).not.toContain('<ScRiPt');

    const anchor = sanitizeAttributionHtml('<A HREF="https://osm.org">OSM</A>');
    expectInert(anchor);
    expect(anchor).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('drops the author target and rel and writes our own', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org" target="_self" rel="opener">OSM</a>',
    );
    expect(out).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('drops style, id, class and srcdoc from an anchor', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org" style="position:fixed;inset:0" id="x" class="y" srcdoc="z">OSM</a>',
    );
    expect(out).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('allows the formatting set but strips its attributes', () => {
    const out = sanitizeAttributionHtml(
      '<b onclick="a()">bold</b><span style="x">s</span><em>e</em><i>i</i><strong>st</strong>',
    );
    expectInert(out);
    expect(out).toBe(
      '<b>bold</b><span>s</span><em>e</em><i>i</i><strong>st</strong>',
    );
  });
});

describe('sanitizeAttributionHtml: malformed markup', () => {
  it('treats an unterminated tag as text', () => {
    const out = sanitizeAttributionHtml('<a href="https://osm.org');
    expectInert(out);
    expect(out).toContain('&lt;a href=');
    expect(out).not.toMatch(/<a\s/);
  });

  it('treats an unterminated quoted attribute as text', () => {
    const out = sanitizeAttributionHtml('<a href="https://osm.org>OSM</a>');
    expectInert(out);
    expect(out).not.toMatch(/<a\s/);
  });

  it('closes an unclosed allowed element', () => {
    const out = sanitizeAttributionHtml('<b>bold');
    expect(out).toBe('<b>bold</b>');
  });

  it('closes an unclosed anchor', () => {
    const out = sanitizeAttributionHtml('<a href="https://osm.org">OSM');
    expect(out).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('keeps an attribute value that contains a greater-than sign', () => {
    // The quoted value swallows the '>', so a tokenizer that scans for
    // the first '>' would cut the tag in half here and leave the tail
    // as markup.
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org/?a=1>2&amp;b=3" title="x>y">OSM</a>',
    );
    expectInert(out);
    expect(out).toBe(
      '<a href="https://osm.org/?a=1&gt;2&amp;b=3" target="_blank" rel="noopener noreferrer">OSM</a>',
    );
  });

  it('does not let a value-embedded greater-than smuggle a handler', () => {
    const out = sanitizeAttributionHtml(
      '<a title="><img src=x onerror=alert(1)>" href="https://osm.org">OSM</a>',
    );
    expectInert(out);
    expect(out).not.toContain('<img');
  });

  it('rebalances interleaved tags into well-formed output', () => {
    const out = sanitizeAttributionHtml('<b><i>x</b>y</i>');
    expectInert(out);
    // Closing <b> closes the <i> inside it first; the later </i> has
    // nothing to match and is shown as text rather than dropped.
    expect(out).toBe('<b><i>x</i></b>y&lt;/i&gt;');
  });

  it('shows a stray end tag as text', () => {
    const out = sanitizeAttributionHtml('</b>');
    expect(out).toBe('&lt;/b&gt;');
  });

  it('nests allowed elements', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://osm.org"><b>OSM</b> <i>contributors</i></a>',
    );
    expectInert(out);
    expect(out).toBe(
      '<a href="https://osm.org" target="_blank" rel="noopener noreferrer">' +
        '<b>OSM</b> <i>contributors</i></a>',
    );
  });

  it('treats a lone less-than as text', () => {
    expect(sanitizeAttributionHtml('a < b')).toBe('a &lt; b');
    expect(sanitizeAttributionHtml('<3')).toBe('&lt;3');
    expect(sanitizeAttributionHtml('trailing <')).toBe('trailing &lt;');
  });

  it('caps the input length', () => {
    const long = 'a'.repeat(MAX_ATTRIBUTION_LENGTH + 500);
    expect(sanitizeAttributionHtml(long).length).toBe(MAX_ATTRIBUTION_LENGTH);
  });

  it('returns empty for non-strings', () => {
    expect(sanitizeAttributionHtml(undefined)).toBe('');
    expect(sanitizeAttributionHtml(null)).toBe('');
    expect(sanitizeAttributionHtml(42)).toBe('');
    expect(sanitizeAttributionHtml({ toString: () => '<b>x' })).toBe('');
    expect(sanitizeAttributionHtml('')).toBe('');
  });
});

describe('sanitizeAttributionHtml: legitimate attribution survives', () => {
  it('keeps the real OSM attribution, link and all', () => {
    const osm =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const out = sanitizeAttributionHtml(osm);
    expectInert(out);
    expect(out).toBe(
      '© <a href="https://www.openstreetmap.org/copyright" ' +
        'target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    );
  });

  it('keeps the seeded plain-text attributions byte for byte', () => {
    // These are the strings in BUILTIN_BASEMAP_SEEDS. If sanitizing
    // changed them, every seeded basemap would rewrite on first save.
    for (const seed of [
      '(c) OpenStreetMap contributors',
      '(c) OpenStreetMap contributors (c) Carto',
      'Imagery (c) U.S. Geological Survey, The National Map',
    ]) {
      expect(sanitizeAttributionHtml(seed)).toBe(seed);
    }
  });

  it('keeps a plain-text attribution with an ampersand, HTML-encoded', () => {
    expect(sanitizeAttributionHtml('Smith & Sons Surveying')).toBe(
      'Smith &amp; Sons Surveying',
    );
  });

  it('keeps a multi-provider attribution with two links', () => {
    const input =
      '<a href="https://www.maptiler.com/copyright/">MapTiler</a> | ' +
      '<a href="https://www.openstreetmap.org/copyright">OSM contributors</a>';
    const out = sanitizeAttributionHtml(input);
    expectInert(out);
    expect(hrefsIn(out)).toEqual([
      'https://www.maptiler.com/copyright/',
      'https://www.openstreetmap.org/copyright',
    ]);
    expect(out).toContain('MapTiler');
    expect(out).toContain('OSM contributors');
  });

  it('keeps http as well as https', () => {
    const out = sanitizeAttributionHtml(
      '<a href="http://legacy.example.gov/terms">Terms</a>',
    );
    expect(hrefsIn(out)).toEqual(['http://legacy.example.gov/terms']);
  });

  it('keeps query strings and fragments intact through the escape', () => {
    const out = sanitizeAttributionHtml(
      '<a href="https://example.org/a?b=1&amp;c=2#frag">x</a>',
    );
    expect(out).toContain('href="https://example.org/a?b=1&amp;c=2#frag"');
  });

  it('preserves a copyright sign written literally', () => {
    expect(sanitizeAttributionHtml('© OpenStreetMap')).toBe(
      '© OpenStreetMap',
    );
  });
});

describe('sanitizeAttributionHtml: idempotence', () => {
  // The API sanitizes on write and the web sanitizes again on render,
  // so any value that is not a fixed point drifts every save.
  const INPUTS = [
    '&copy; OpenStreetMap contributors',
    '© OpenStreetMap contributors',
    '(c) OpenStreetMap contributors',
    'Smith & Sons',
    'Smith &amp; Sons',
    '<a href="https://osm.org">OSM</a>',
    '<a href="javascript:alert(1)">OSM</a>',
    '<img src=x onerror=alert(1)>',
    '<b>bold',
    '</b>',
    'a < b > c',
    '"quoted" and \'single\'',
    '<a href="https://example.org/a?b=1&c=2">x</a>',
  ];

  it.each(INPUTS)('is a fixed point after one pass for %j', (input) => {
    const once = sanitizeAttributionHtml(input);
    expect(sanitizeAttributionHtml(once)).toBe(once);
    expect(sanitizeAttributionHtml(sanitizeAttributionHtml(once))).toBe(once);
  });
});
