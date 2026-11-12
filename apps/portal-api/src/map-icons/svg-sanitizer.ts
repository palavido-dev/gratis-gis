// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal SVG sanitizer (#73). User-uploaded SVGs are a known XSS
 * vector -- attackers can embed `<script>`, `<foreignObject>`,
 * `<image href="...">`, `on*` event-handler attrs, javascript:
 * URLs, etc. This sanitizer walks the SVG with an explicit
 * allowlist and rejects anything outside of it.
 *
 * Approach: regex-only single-pass tokenization. We don't pull in
 * a DOM parser -- the SVG body we accept is a tiny subset of XML
 * (just element + attribute tokens, no DTD / CDATA / comments
 * survive) so the regex pass is correct enough and cheap. Failure
 * mode: anything ambiguous returns null and the upload is
 * rejected with a clear message.
 *
 * What we allow:
 *   - Elements: svg, g, path, circle, ellipse, rect, line,
 *     polyline, polygon, defs, title, desc, use (with self-#
 *     references only)
 *   - Attributes: a fixed list (d, x, y, x1, y1, x2, y2, cx, cy,
 *     r, rx, ry, width, height, transform, fill, stroke,
 *     stroke-width, stroke-linecap, stroke-linejoin, stroke-
 *     dasharray, viewBox, xmlns, opacity, fill-opacity, stroke-
 *     opacity, points, id, class, style)
 *
 * What we reject:
 *   - <script>, <foreignObject>, <iframe>, <embed>, <object>,
 *     <image>, <video>, <audio>, <a href>, <use href> (when href
 *     isn't '#localFrag'), event handlers (`on*`),
 *     javascript: / data: URLs in any attr,
 *     <style> tags (rules can carry url(javascript:) payloads),
 *     external resource references.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'title',
  'desc',
  'use',
]);

const ALLOWED_ATTRS = new Set([
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-miterlimit',
  'viewBox',
  'xmlns',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'points',
  'id',
  'class',
  'style',
  'href',
  // SMIL animation, allowed but rare:
  // 'begin', 'dur', 'from', 'to', 'attributeName', 'repeatCount',
]);

const STYLE_BAD = /(javascript|data|expression|url\s*\()/i;
const URL_BAD = /^\s*(javascript|data):/i;

/**
 * Sanitize an SVG document body. Returns the cleaned SVG body
 * (without the surrounding `<?xml?>` declaration or `<!DOCTYPE>`)
 * or null when the input contained anything outside the
 * allowlist.
 *
 * The output is guaranteed to be:
 *   - parseable by every modern browser's SVG engine
 *   - free of `<script>`, event handlers, and external resource
 *     URLs
 *   - rooted at a single `<svg>` element with `viewBox`
 *
 * Size cap (1 MB) is enforced by the caller (multer limit on
 * the endpoint).
 */
export function sanitizeSvg(input: string): string | null {
  // Strip processing instructions, DOCTYPE, comments, and
  // CDATA up front. These are not allowed in the output and
  // simplify the tokenizer.
  //
  // Comments and CDATA are cut with indexOf, not a lazy regex: an
  // unterminated opener made the regex rescan to the end of the input
  // from every opener, so a 1 MB upload of repeated `<!--` held the
  // API for about a minute. An unterminated one is now a rejection.
  const noComments = stripBlocks(input, '<!--', '-->');
  if (noComments === null) return null;
  const noCdata = stripBlocks(noComments, '<![CDATA[', ']]>');
  if (noCdata === null) return null;
  let src = noCdata
    .replace(/<\?[^?]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  // Reject UTF-16 BOMs / unusual chars that could be used to
  // smuggle past the regex layer. (Inputs come from a form
  // upload; we treat exotic characters as suspicious.)
  // Use indexOf with a String.fromCharCode literal rather than a
  // regex so we don't trip ESLint's no-control-regex rule.
  if (src.indexOf(String.fromCharCode(0)) !== -1) return null;

  // Token-by-token walk. We rebuild the SVG from the parsed
  // tokens rather than try to filter the source string in
  // place, so anything we don't recognise is silently dropped.
  const out: string[] = [];
  let i = 0;
  let depth = 0;
  let rootSvgSeen = false;

  while (i < src.length) {
    if (src[i] !== '<') {
      // Text content. Only preserve inside <title> / <desc> /
      // <style> -- but we reject <style> entirely, and the
      // only useful text content is in title/desc. For
      // generality we preserve any text between elements (the
      // browser ignores stray text outside descriptive
      // children).
      const next = src.indexOf('<', i);
      const end = next < 0 ? src.length : next;
      const text = src.slice(i, end);
      if (text.trim().length > 0) {
        out.push(escapeText(text));
      }
      i = end;
      continue;
    }

    // We're at a `<`. Determine element vs. closing tag.
    const closing = src[i + 1] === '/';
    const tagEnd = src.indexOf('>', i);
    if (tagEnd < 0) return null;
    const inner = src.slice(i + 1 + (closing ? 1 : 0), tagEnd);
    const selfClosing = inner.endsWith('/');
    const innerNoSlash = selfClosing ? inner.slice(0, -1) : inner;
    const m = innerNoSlash.match(/^([a-zA-Z][\w-]*)/);
    if (!m) return null;
    const tag = m[1]!.toLowerCase();

    if (!ALLOWED_ELEMENTS.has(tag)) {
      // Element not allowlisted -- reject the whole input
      // rather than silently dropping the element. An attacker
      // who can get a <script> through deserves a hard fail.
      return null;
    }

    if (closing) {
      if (depth <= 0) return null;
      out.push(`</${tag}>`);
      depth -= 1;
      i = tagEnd + 1;
      continue;
    }

    // Opening tag. Parse attributes.
    const attrsRaw = innerNoSlash.slice(m[1]!.length);
    const attrs = parseAttrs(attrsRaw);
    if (!attrs) return null;
    // Filter to allowlisted + safe attrs.
    const kept: Array<[string, string]> = [];
    for (const [name, value] of attrs) {
      const ln = name.toLowerCase();
      if (ln.startsWith('on')) return null; // event handler
      if (ln === 'href' || ln === 'xlink:href') {
        // `<use href="#foo">` is fine; external refs are not.
        if (!value.startsWith('#')) return null;
        if (URL_BAD.test(value)) return null;
        kept.push(['href', value]);
        continue;
      }
      if (!ALLOWED_ATTRS.has(ln)) {
        // Drop silently rather than fail; lots of editors emit
        // benign extras (inkscape:label, sodipodi:nodetypes,
        // etc.).
        continue;
      }
      if (ln === 'style' && STYLE_BAD.test(value)) return null;
      if (URL_BAD.test(value)) return null;
      kept.push([ln, value]);
    }

    if (tag === 'svg') {
      if (rootSvgSeen) return null; // Only one root svg allowed.
      rootSvgSeen = true;
      // Force xmlns + viewBox so the output is portable. The
      // browser handles missing xmlns OK on inline SVG but
      // strict consumers (sharp, librsvg) need it.
      if (!kept.some(([k]) => k === 'xmlns')) {
        kept.unshift(['xmlns', 'http://www.w3.org/2000/svg']);
      }
      if (!kept.some(([k]) => k === 'viewbox')) {
        // Default to 0 0 24 24 to match the lucide style.
        kept.push(['viewBox', '0 0 24 24']);
      }
    }

    const attrText = kept
      .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
      .join(' ');
    out.push(`<${tag}${attrText ? ' ' + attrText : ''}${selfClosing ? '/' : ''}>`);
    if (!selfClosing) depth += 1;
    i = tagEnd + 1;
  }

  if (!rootSvgSeen) return null;
  if (depth !== 0) return null;
  return out.join('');
}

/**
 * Remove every `open ... close` block. Null when an opener has no
 * closer (the input is malformed and is refused).
 */
function stripBlocks(input: string, open: string, close: string): string | null {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = input.indexOf(open, pos);
    if (start === -1) return out + input.slice(pos);
    const end = input.indexOf(close, start + open.length);
    if (end === -1) return null;
    out += input.slice(pos, start);
    pos = end + close.length;
  }
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNameStart = (c: string) => /[a-zA-Z_:]/.test(c);
const isNameChar = (c: string) => /[A-Za-z0-9_\-:]/.test(c);
const isUnquotedStop = (c: string) => isSpace(c) || c === '"' || c === "'" || c === '<' || c === '>' || c === '`';

/**
 * name = "value" | 'value' | value, separated by whitespace, and
 * nothing else. A single left-to-right scan: the attribute regex this
 * replaced restarted from every position of a long run of name
 * characters with no `=`, which was quadratic.
 */
function parseAttrs(input: string): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  const n = input.length;
  let i = 0;
  for (;;) {
    while (i < n && isSpace(input[i]!)) i++;
    if (i >= n) return out;
    if (!isNameStart(input[i]!)) return null;
    const nameStart = i;
    i++;
    while (i < n && isNameChar(input[i]!)) i++;
    const name = input.slice(nameStart, i);
    while (i < n && isSpace(input[i]!)) i++;
    if (input[i] !== '=') return null;
    i++;
    while (i < n && isSpace(input[i]!)) i++;
    let value: string;
    const q = input[i];
    if (q === '"' || q === "'") {
      const end = input.indexOf(q, i + 1);
      if (end === -1) return null;
      value = input.slice(i + 1, end);
      i = end + 1;
    } else {
      const vStart = i;
      while (i < n && !isUnquotedStop(input[i]!)) i++;
      if (i === vStart) return null;
      value = input.slice(vStart, i);
    }
    out.push([name, decodeEntities(value)]);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
