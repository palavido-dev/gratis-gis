// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sanitizer for map attribution strings.
 *
 * Attribution is the one user-authored string in the portal that is
 * rendered as HTML rather than as text. MapLibre's `AttributionControl`
 * takes whatever a source declares and writes it into the DOM through
 * its own internal `DOM.sanitize()`, and that sanitizer is the subject
 * of GHSA-jrc7-96c5-q579 (CVE-2026-85061): a bypass that survives every
 * maplibre-gl at or below 6.4.0. We are pinned to 5.24.0 because
 * maplibre 6 removed `Map.transform` and `@deck.gl/mapbox` still reads
 * it every render, which breaks point clouds. So instead of relying on
 * the library's sanitizer we make sure nothing hostile ever reaches it:
 * the value is cleaned here, and this output is safe as `innerHTML`
 * even if the library's own sanitizer is a no-op.
 *
 * The sink is a stored one and crosses a privilege boundary. Writing a
 * basemap item needs `can_publish_items` (contributor or admin), but
 * every viewer of every map that references that basemap renders the
 * string, including anonymous viewers of a public map. Attribution can
 * also arrive from a third party entirely: `/admin/basemap/probe` lifts
 * it out of a remote service's own capabilities document (ArcGIS
 * `copyrightText`, WMS / WMTS `AccessConstraints`), and the tile_layer
 * finalize step lifts it out of an uploaded PMTiles header.
 *
 * WHY NOT STRIP ALL HTML. OSM's licence terms require a working
 * attribution LINK, and the same is true of most commercial tile
 * providers. Escaping the anchor would leave the deployment out of
 * compliance, so a minimal anchor has to survive.
 *
 * WHY NOT A REGEX. Rewriting HTML with regular expressions is the exact
 * bug class this file exists to close. What follows is a small explicit
 * tokenizer with a total grammar: every byte of the input is either
 * consumed as part of a well formed tag or emitted as text. There is no
 * "skip the thing I did not understand" path, which is where sanitizers
 * usually leak.
 *
 * THE RULES, and the reasoning for each:
 *
 *  - Allowed elements are `a` plus the attribute free inline formatting
 *    set (`b`, `strong`, `em`, `i`, `span`). None of them can carry a
 *    URL or script, and none of them switches the HTML parser into a
 *    foreign content mode, which is what mXSS payloads need. Our own
 *    seeds in `BUILTIN_BASEMAP_SEEDS` are plain text, but third party
 *    capabilities documents do use bold and italics, and escaping those
 *    into visible `<b>` noise would be a cosmetic regression on
 *    perfectly legitimate input.
 *  - An allowed element keeps NO attributes it supplied. `<a>` gets a
 *    validated `href` plus a `target` and `rel` we write ourselves; the
 *    formatting elements get nothing at all. Dropping an unknown
 *    attribute rather than escaping the whole tag keeps a legitimate
 *    link working when an upstream decorates it with `class` or
 *    `title`.
 *  - Everything else becomes ESCAPED TEXT, not silence: a disallowed
 *    element, a stray end tag, an anchor whose href was refused, an
 *    unterminated tag. The author sees exactly what they wrote sitting
 *    in the attribution control, which is the feedback channel. A
 *    sanitizer that deletes quietly teaches authors that their input
 *    worked.
 *
 * IDEMPOTENCE IS A REQUIREMENT, not a nicety. portal-api cleans on
 * write and portal-web cleans again on render, so most values are
 * sanitized twice and stored values are re-sanitized on every save.
 * That is why text is entity DECODED before it is escaped: without the
 * decode, `&copy; OpenStreetMap contributors` (the placeholder the
 * basemap editor suggests) would become the literal text `&copy;` on
 * the first pass and `&amp;copy;` on the second. Decode-then-escape is
 * a fixed point: `&copy;` decodes to the character, which needs no
 * escape, so pass two is a no-op.
 *
 * PURE AND DOM FREE. portal-api runs this in Node on the write path and
 * portal-web runs it in the browser on the render path; both must agree
 * exactly, so there is no `document`, no `DOMParser`, and no
 * environment branch.
 *
 * Every non-ASCII character below is written as an escape sequence on
 * purpose. An earlier file in this package shipped two raw NUL bytes
 * that git read as binary and the editor rendered as spaces; escapes
 * make a control character impossible to introduce by accident.
 */

/**
 * Elements that survive sanitizing. `a` is special cased below because
 * it is the only one that keeps an attribute.
 */
export const ALLOWED_ATTRIBUTION_TAGS = [
  'a',
  'b',
  'strong',
  'em',
  'i',
  'span',
] as const;

export type AllowedAttributionTag = (typeof ALLOWED_ATTRIBUTION_TAGS)[number];

const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(ALLOWED_ATTRIBUTION_TAGS);

/**
 * Longest input accepted. Real attribution strings run well under 300
 * characters; the cap exists so a hostile author cannot park a
 * multi-megabyte blob in a column every viewer of the map downloads.
 * Applied to the INPUT: truncating mid-tag is safe because an
 * unterminated tag degrades to text by construction.
 */
export const MAX_ATTRIBUTION_LENGTH = 2000;

/**
 * Sanitize one attribution string. Returns HTML that is safe to assign
 * to `innerHTML` with no further processing, and safe to hand to
 * MapLibre whether or not its own sanitizer does anything.
 *
 * Non-strings (a JSON payload with `attribution: 42`, or a missing
 * field) collapse to the empty string, so a caller can treat the result
 * as "the attribution, or nothing".
 */
export function sanitizeAttributionHtml(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const source =
    input.length > MAX_ATTRIBUTION_LENGTH
      ? input.slice(0, MAX_ATTRIBUTION_LENGTH)
      : input;

  const out: string[] = [];
  /** Allowed elements currently open, innermost last. */
  const open: string[] = [];

  for (const token of tokenize(source)) {
    if (token.kind === 'text') {
      out.push(escapeHtml(decodeHtmlEntities(token.text)));
      continue;
    }
    if (token.kind === 'start') {
      const rendered = renderStartTag(token);
      if (rendered === null) {
        // Refused: show it rather than deleting it.
        out.push(escapeHtml(decodeHtmlEntities(token.raw)));
        continue;
      }
      out.push(rendered);
      // The slash in `<b/>` is ignored by the HTML parser for every
      // non-void element, and none of the allowed elements are void,
      // so a self-closing spelling opens the element just the same.
      open.push(token.name);
      continue;
    }
    // End tag. Close down to the nearest matching open element so the
    // output stays well formed even when the input interleaved tags.
    const depth = lastIndexOfTag(open, token.name);
    if (depth === -1) {
      out.push(escapeHtml(decodeHtmlEntities(token.raw)));
      continue;
    }
    for (let i = open.length - 1; i >= depth; i--) out.push(`</${open[i]}>`);
    open.length = depth;
  }

  // Anything the author left open, we close. An unbalanced fragment
  // handed to innerHTML is where "the rest of the page is now inside my
  // element" surprises come from.
  for (let i = open.length - 1; i >= 0; i--) out.push(`</${open[i]}>`);

  return out.join('');
}

// ---------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------

interface TextToken {
  kind: 'text';
  text: string;
}

interface StartTagToken {
  kind: 'start';
  name: string;
  /** First occurrence wins, matching how a browser resolves duplicates. */
  attrs: ReadonlyMap<string, string>;
  /** Verbatim source, used when the tag is refused and shown as text. */
  raw: string;
}

interface EndTagToken {
  kind: 'end';
  name: string;
  raw: string;
}

type Token = TextToken | StartTagToken | EndTagToken;

/**
 * The grammar, stated so it can be argued with:
 *
 *   document  := ( tag | text )*
 *   tag       := '<' '/'? name ( sep* attribute )* sep* '/'? '>'
 *   name      := [A-Za-z] [A-Za-z0-9-]*
 *   attribute := attrName ( sep* '=' sep* attrValue )?
 *   attrName  := [^ \t\n\r\f/>="']+
 *   attrValue := '"' [^"]* '"' | "'" [^']* "'" | [^ \t\n\r\f>]*
 *
 * Anything that does not match this, including an unterminated tag, a
 * `<` followed by a digit, or a lone `<` at the end of the string, is
 * text. That totality is the safety property: there is no input for
 * which the tokenizer silently discards bytes.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let i = 0;

  const flushText = (): void => {
    if (text.length > 0) {
      tokens.push({ kind: 'text', text });
      text = '';
    }
  };

  while (i < source.length) {
    if (source[i] !== '<') {
      text += source[i];
      i += 1;
      continue;
    }
    const tag = readTag(source, i);
    if (tag === null) {
      // Not a tag after all. The '<' is literal content.
      text += '<';
      i += 1;
      continue;
    }
    flushText();
    tokens.push(tag.token);
    i = tag.end;
  }

  flushText();
  return tokens;
}

const TAG_NAME_START = /[A-Za-z]/;
const TAG_NAME_CHAR = /[A-Za-z0-9-]/;
const HTML_SPACE = /[ \t\n\r\f]/;

function readTag(
  source: string,
  start: number,
): { token: Token; end: number } | null {
  let i = start + 1;
  const isEnd = source[i] === '/';
  if (isEnd) i += 1;

  const nameStart = i;
  if (i >= source.length || !TAG_NAME_START.test(source[i] as string)) {
    return null;
  }
  while (i < source.length && TAG_NAME_CHAR.test(source[i] as string)) i += 1;
  const name = source.slice(nameStart, i).toLowerCase();

  if (isEnd) {
    while (i < source.length && HTML_SPACE.test(source[i] as string)) i += 1;
    if (source[i] !== '>') return null;
    i += 1;
    return {
      token: { kind: 'end', name, raw: source.slice(start, i) },
      end: i,
    };
  }

  const attrs = new Map<string, string>();
  while (i < source.length) {
    const c = source[i] as string;
    if (HTML_SPACE.test(c)) {
      i += 1;
      continue;
    }
    if (c === '>') {
      i += 1;
      return {
        token: { kind: 'start', name, attrs, raw: source.slice(start, i) },
        end: i,
      };
    }
    if (c === '/') {
      // Either the self-closing marker or, as in the classic
      // `<svg/onload=...>` payload, a bare separator the HTML parser
      // treats as whitespace before the next attribute name. Advancing
      // one character covers both without a special case.
      i += 1;
      continue;
    }

    const attrNameStart = i;
    while (
      i < source.length &&
      !HTML_SPACE.test(source[i] as string) &&
      source[i] !== '=' &&
      source[i] !== '>' &&
      source[i] !== '/' &&
      source[i] !== '"' &&
      source[i] !== "'"
    ) {
      i += 1;
    }
    if (i === attrNameStart) {
      // A quote or '=' where a name should start. Consume it so the
      // loop always makes progress; the tag is still refused whole if
      // it never reaches a '>'.
      i += 1;
      continue;
    }
    const attrName = source.slice(attrNameStart, i).toLowerCase();

    while (i < source.length && HTML_SPACE.test(source[i] as string)) i += 1;
    let value = '';
    if (source[i] === '=') {
      i += 1;
      while (i < source.length && HTML_SPACE.test(source[i] as string)) i += 1;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        // An unterminated quoted value means the tag never ends. Refuse
        // the whole thing rather than guessing where it stopped.
        if (close === -1) return null;
        value = source.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (
          i < source.length &&
          !HTML_SPACE.test(source[i] as string) &&
          source[i] !== '>'
        ) {
          i += 1;
        }
        value = source.slice(valueStart, i);
      }
    }
    // A browser keeps the FIRST of two same-named attributes, so
    // `href="javascript:..." href="https://ok"` must resolve to the
    // hostile one and be refused, not to the decoy.
    if (!attrs.has(attrName)) attrs.set(attrName, value);
  }

  // Ran off the end without a '>'.
  return null;
}

// ---------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------

/**
 * Render an allowed start tag, or null to refuse it (the caller then
 * shows the raw source as text).
 *
 * Note what is NOT done here: nothing is removed from a collection
 * while that collection is being iterated. The CVE this file answers is
 * exactly that bug, a walk over the live `NamedNodeMap` that calls
 * `removeAttribute` by index, so removing one attribute shifts the next
 * into the slot already visited and it is never examined. Building the
 * output from an allowlist instead of subtracting from the input makes
 * that failure mode unrepresentable.
 */
function renderStartTag(token: StartTagToken): string | null {
  if (!ALLOWED_TAG_SET.has(token.name)) return null;
  if (token.name !== 'a') return `<${token.name}>`;

  const href = token.attrs.get('href');
  if (href === undefined) return null;
  const safe = safeHttpUrl(href);
  if (safe === null) return null;
  // target and rel are ours, not the author's: an attribution link
  // opens a third party site, and `noopener` keeps that site from
  // reaching back through `window.opener`.
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">`;
}

/**
 * Control characters the URL parser drops wherever they appear, plus
 * the rest of the C0 range and DEL for good measure. Removing them
 * before the scheme test is what closes `java&#9;script:alert(1)`.
 *
 * no-control-regex is right nearly everywhere and wrong here: matching
 * control characters IS the point. The rule cannot tell "someone pasted
 * a stray byte into a pattern" from "someone is deliberately filtering
 * stray bytes".
 */
// eslint-disable-next-line no-control-regex
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Accept an absolute http(s) URL, reject everything else.
 *
 * This is an allowlist on the scheme, deliberately, rather than a
 * blocklist of `javascript:` / `data:` / `vbscript:`. A blocklist has to
 * anticipate every scheme and every spelling of it; requiring the string
 * to START with `http://` or `https://` refuses all of them at once,
 * including protocol-relative `//evil.example` and any relative path.
 *
 * Two normalizations happen before the test, both because the browser
 * does them too and testing the pre-normalized string would test a
 * string nobody ever parses:
 *
 *  - HTML character references are decoded, so `&#106;avascript:` and
 *    `&Tab;` are seen for what they are.
 *  - Control characters are removed from anywhere in the value, not
 *    just the ends.
 *
 * The value RETURNED is the normalized one, so the string that was
 * validated is byte for byte the string that gets written into the
 * document. That invariant is what makes an incomplete named-entity
 * table (see `NAMED_ENTITIES`) safe: under-decoding can only cause a
 * URL to fail the http(s) test, never to pass it wearing a disguise.
 */
function safeHttpUrl(rawHref: string): string | null {
  const decoded = decodeHtmlEntities(rawHref);
  const normalized = decoded.replace(URL_CONTROL_CHARS, '').trim();
  const lower = normalized.toLowerCase();
  const scheme = lower.startsWith('https://')
    ? 'https://'
    : lower.startsWith('http://')
      ? 'http://'
      : null;
  if (scheme === null) return null;
  // A bare scheme is not a destination; without this, `https://`
  // reaches the DOM as a link back to the current origin.
  if (normalized.length === scheme.length) return null;
  return normalized;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape for both text and attribute-value contexts at once. One
 * function for both is deliberate: a two-function design invites the
 * bug where the wrong one is called at a new call site, and the extra
 * escaping in text position is invisible once rendered.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * Named character references this decoder knows.
 *
 * This is deliberately NOT the full HTML5 table. That table is 2,231
 * entries, it would ship in a package portal-api loads at runtime, and
 * the entries beyond this set exist so mathematical and Greek notation
 * renders, which no attribution string needs.
 *
 * The reason a partial table is not a shortcut in the security sense:
 * every consumer of a decoded value re-emits the DECODED form (text is
 * escaped, hrefs are returned normalized from `safeHttpUrl`), so a
 * reference this table does not know stays literal end to end. Missing
 * one can make a legitimate URL fail the http(s) test. It cannot make a
 * hostile one pass, because passing requires the decoded string to
 * begin with `http://` or `https://`, and that same decoded string is
 * what gets written out.
 *
 * Lookup is case-insensitive even though HTML's own table is not.
 * Over-decoding is safe for the same reason: `&COLON;` is literal to a
 * browser, so treating it as `:` can only push a value further away
 * from the http(s) prefix, never towards it.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  hellip: '…',
  ndash: '–',
  // The house style bans em dashes in anything we write. This table is
  // not writing: it is the HTML named-character-reference mapping, and
  // `&mdash;` has to decode to U+2014 or an attribution containing one
  // renders wrong. Kept as a literal for consistency with the other
  // entries rather than singled out as an escape. A grep for em dashes
  // in prose should skip this file's table.
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  // The rest are here for the scheme check rather than for rendering:
  // each one is a character an obfuscated `javascript:` is built from.
  tab: '\t',
  newline: '\n',
  colon: ':',
  sol: '/',
  semi: ';',
  num: '#',
  percnt: '%',
  lpar: '(',
  rpar: ')',
  commat: '@',
  quest: '?',
  equals: '=',
  ast: '*',
  excl: '!',
  comma: ',',
  period: '.',
  dollar: '$',
  lowbar: '_',
  verbar: '|',
  grave: '`',
  plus: '+',
};

const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode HTML character references. Requires the trailing semicolon,
 * which is stricter than a browser's legacy no-semicolon rule; see the
 * note on `NAMED_ENTITIES` for why erring towards under-decoding is the
 * safe direction here.
 */
function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code)) return match;
      // Nothing outside the Unicode range, and no lone surrogate: both
      // throw from fromCodePoint, and neither is a character a browser
      // would have produced either.
      if (code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function lastIndexOfTag(open: readonly string[], name: string): number {
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i] === name) return i;
  }
  return -1;
}
