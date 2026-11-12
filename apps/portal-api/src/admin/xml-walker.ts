// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vendored WMS/WMTS XML walker (#46).
 *
 * Replaces fast-xml-parser for the basemap-probe controller. The
 * controller is the only call site, and the inputs are a narrow
 * subset of XML: well-formed WMS / WMTS GetCapabilities responses
 * (and the occasional ArcGIS-style WMTS variant). Carrying a
 * full-featured XML library for one call site bloats the dep tree
 * and adds a CVE surface we don't need.
 *
 * The output shape matches what fast-xml-parser produced under the
 * controller's existing options:
 *   { ignoreAttributes: false, attributeNamePrefix: '@_',
 *     removeNSPrefix: true, parseAttributeValue: false,
 *     parseTagValue: false, trimValues: true }
 *
 * Specifically:
 *   - Each element becomes an object keyed by child element name.
 *   - If a child name occurs once, the value is the child object
 *     (or a bare string for text-only children).
 *   - If a child name occurs multiple times, the value is an array
 *     of those children.
 *   - Attributes land on the object under `@_<name>`.
 *   - Mixed content (attributes + text) lands as `#text: '...'`.
 *   - Namespace prefixes (`ows:`, `wmts:`, `xlink:`, etc.) are
 *     stripped from element and attribute names.
 *   - All values are strings; consumers handle numeric / boolean
 *     coercion themselves.
 *
 * Out of scope (intentionally):
 *   - DTDs, entity declarations beyond the five predefined.
 *   - Processing instructions other than `<?xml ... ?>` (skipped).
 *   - Mixed content where text and child elements are interleaved
 *     (WMS/WMTS doesn't produce this).
 *   - XML namespaces with semantics (we strip prefixes, full stop).
 *   - Strict well-formedness diagnostics. A malformed doc throws
 *     with the offset, but the message is terse on purpose.
 *
 * The parser is a hand-written state machine. Linear time in the
 * input length. No regexes in the hot path: every character class
 * is decided with charCodeAt comparisons so the parser doesn't
 * trip CodeQL's polynomial-redos check on adversarial input.
 */

/** A parsed XML element. fast-xml-parser-compatible shape. */
export interface XmlElement {
  [key: string]: XmlValue | undefined;
}
export type XmlValue = string | number | boolean | XmlElement | XmlValue[];

/**
 * Parse an XML document and return the root object. The root is a
 * single-key object: `{ [rootName]: XmlElement | string }`. Callers
 * read the root by name, exactly as fast-xml-parser produced.
 *
 * Throws on malformed input with a position indicator.
 */
export function parseXml(xml: string): XmlElement {
  const p = new XmlParser(xml);
  return p.parseDocument();
}

class XmlParser {
  private readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  /** Top-level: skip prolog (XML declaration, comments, doctype),
   *  then parse exactly one root element. */
  parseDocument(): XmlElement {
    this.skipProlog();
    if (this.pos >= this.src.length || this.src.charCodeAt(this.pos) !== 60) {
      // 60 = '<'
      this.fail('expected root element');
    }
    const { name, content } = this.parseElement();
    // Trailing whitespace / comments are fine; anything else after
    // the root is non-well-formed but we tolerate it.
    return { [name]: content };
  }

  /**
   * Skip the prolog: XML declaration `<?xml ...?>`, comments
   * `<!-- ... -->`, doctype `<!DOCTYPE ...>` (we don't follow
   * entity references), and whitespace. Returns when the cursor
   * is positioned at the first non-prolog character.
   */
  private skipProlog(): void {
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) return;
      if (this.src.charCodeAt(this.pos) !== 60) return; // '<'
      // Disambiguate the next token.
      if (this.startsWith('<?')) {
        this.advanceTo('?>');
        this.pos += 2;
        continue;
      }
      if (this.startsWith('<!--')) {
        this.advanceTo('-->');
        this.pos += 3;
        continue;
      }
      if (this.startsWith('<!')) {
        // DOCTYPE or other declaration: skip to the matching `>`,
        // honoring an internal subset `[...]` if present.
        this.pos += 2;
        let depth = 0;
        while (this.pos < this.src.length) {
          const ch = this.src.charCodeAt(this.pos);
          if (ch === 91 /* '[' */) depth++;
          else if (ch === 93 /* ']' */) depth--;
          else if (ch === 62 /* '>' */ && depth <= 0) {
            this.pos++;
            break;
          }
          this.pos++;
        }
        continue;
      }
      // Regular `<` -- the root element starts here.
      return;
    }
  }

  /**
   * Parse one element starting at the current `<`. Returns the
   * element's stripped local name and its content (an XmlElement
   * object, or a bare string for text-only elements). On entry,
   * `src[pos]` must be `<`. On return, `pos` is one past the
   * element's closing `>`.
   */
  private parseElement(): { name: string; content: XmlValue } {
    if (this.src.charCodeAt(this.pos) !== 60) {
      this.fail("expected '<'");
    }
    this.pos++; // consume '<'
    const rawName = this.readName();
    const name = stripNamespacePrefix(rawName);
    const attrs: Record<string, string> = {};
    let selfClosing = false;

    // Parse attribute list until we hit `>` or `/>`.
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) this.fail('unterminated start tag');
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 62) {
        this.pos++; // consume '>'
        break;
      }
      if (ch === 47) {
        // '/'
        if (this.src.charCodeAt(this.pos + 1) !== 62) {
          this.fail("expected '/>'");
        }
        this.pos += 2;
        selfClosing = true;
        break;
      }
      const attrRawName = this.readName();
      const attrName = stripNamespacePrefix(attrRawName);
      this.skipWhitespace();
      if (this.src.charCodeAt(this.pos) !== 61) {
        // '='
        this.fail("expected '=' in attribute");
      }
      this.pos++;
      this.skipWhitespace();
      const value = this.readAttrValue();
      attrs[`@_${attrName}`] = decodeEntities(value);
    }

    // Self-closing or empty -- content is the attribute map (or
    // empty string if no attributes).
    if (selfClosing) {
      return { name, content: finishElement(attrs, [], null) };
    }

    // Read child content until we hit `</name>`.
    const children: Array<{ name: string; value: XmlValue }> = [];
    let textBuf = '';

    while (this.pos < this.src.length) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 60) {
        // '<'
        if (this.startsWith('</')) {
          // End tag for this element. Consume it.
          this.pos += 2;
          const endRawName = this.readName();
          const endName = stripNamespacePrefix(endRawName);
          if (endName !== name) {
            this.fail(`mismatched end tag </${endName}> for <${name}>`);
          }
          this.skipWhitespace();
          if (this.src.charCodeAt(this.pos) !== 62) {
            this.fail("expected '>' on end tag");
          }
          this.pos++;
          return {
            name,
            content: finishElement(attrs, children, textBuf),
          };
        }
        if (this.startsWith('<!--')) {
          // Skip comments.
          this.advanceTo('-->');
          this.pos += 3;
          continue;
        }
        if (this.startsWith('<![CDATA[')) {
          // CDATA: append raw content, no entity decoding.
          this.pos += 9;
          const endIdx = this.src.indexOf(']]>', this.pos);
          if (endIdx < 0) this.fail('unterminated CDATA');
          textBuf += this.src.slice(this.pos, endIdx);
          this.pos = endIdx + 3;
          continue;
        }
        if (this.startsWith('<?')) {
          // Skip processing instructions.
          this.advanceTo('?>');
          this.pos += 2;
          continue;
        }
        // Otherwise: a child element starts here.
        const child = this.parseElement();
        children.push({ name: child.name, value: child.content });
        continue;
      }
      // Plain text: take the whole run up to the next '<' as one slice.
      // Appending one character at a time built a rope of one-char
      // strings at about 33 bytes of heap per character, so a single
      // 62 MB text node in an uploaded KML used up the API's heap.
      const next = this.src.indexOf('<', this.pos);
      const end = next === -1 ? this.src.length : next;
      textBuf += this.src.slice(this.pos, end);
      this.pos = end;
    }

    this.fail(`unterminated element <${name}>`);
  }

  /** Read an XML name: a letter or underscore followed by name
   *  characters. Returns the raw name with namespace prefix intact;
   *  the caller strips it. */
  private readName(): string {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const ch = this.src.charCodeAt(this.pos);
      if (isNameChar(ch)) {
        this.pos++;
      } else {
        break;
      }
    }
    if (this.pos === start) this.fail('expected name');
    return this.src.slice(start, this.pos);
  }

  /** Read a quoted attribute value. Supports both `"` and `'`
   *  delimiters; the value runs up to the matching close quote. */
  private readAttrValue(): string {
    const quote = this.src.charCodeAt(this.pos);
    if (quote !== 34 && quote !== 39) {
      this.fail("expected attribute value");
    }
    this.pos++;
    const start = this.pos;
    while (this.pos < this.src.length && this.src.charCodeAt(this.pos) !== quote) {
      this.pos++;
    }
    if (this.pos >= this.src.length) this.fail('unterminated attribute value');
    const raw = this.src.slice(start, this.pos);
    this.pos++; // consume closing quote
    return raw;
  }

  /** Walk the cursor forward until it finds `target`. The cursor
   *  lands at `target`'s start (i.e. one past the match would be
   *  `pos + target.length`). Throws on EOF. */
  private advanceTo(target: string): void {
    const idx = this.src.indexOf(target, this.pos);
    if (idx < 0) this.fail(`expected '${target}'`);
    this.pos = idx;
  }

  /** Check whether the cursor's next characters match `s`. */
  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  /** Skip ASCII whitespace (space, tab, CR, LF). */
  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private fail(why: string): never {
    // Slice context around the cursor to make debugging realistic-
    // sized capabilities documents tractable. We don't want to log
    // 200KB on a single parse error.
    const ctx = this.src.slice(Math.max(0, this.pos - 30), this.pos + 30);
    throw new Error(`XML parse error at offset ${this.pos}: ${why} (near "${ctx}")`);
  }
}

/** Strip a leading namespace prefix (`ows:Title` -> `Title`).
 *  `removeNSPrefix: true` in the old parser. */
function stripNamespacePrefix(name: string): string {
  const colon = name.indexOf(':');
  if (colon < 0) return name;
  // `xmlns` and `xmlns:foo` declarations: keep as-is so we don't
  // lose the xmlns marker (the controller doesn't read them, but
  // dropping the prefix would map `xmlns:xlink` -> `xlink` which
  // is misleading).
  if (name.startsWith('xmlns')) return name;
  return name.slice(colon + 1);
}

/** XML name character. Approximate but sufficient: ASCII letters,
 *  digits, `_`, `-`, `.`, `:` (kept so we can read the raw colon-
 *  separated name and let the caller strip the prefix). */
function isNameChar(ch: number): boolean {
  return (
    (ch >= 65 && ch <= 90) || // A-Z
    (ch >= 97 && ch <= 122) || // a-z
    (ch >= 48 && ch <= 57) || // 0-9
    ch === 95 || // '_'
    ch === 45 || // '-'
    ch === 46 || // '.'
    ch === 58 // ':'
  );
}

/**
 * Decode the five predefined XML entities plus decimal and hex
 * character references. Anything we don't recognize passes through
 * unchanged so a stray `&` in attribute text doesn't corrupt
 * downstream consumers (the WMS/WMTS docs sometimes have raw `&`
 * in attribution strings).
 */
function decodeEntities(raw: string): string {
  if (raw.indexOf('&') < 0) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    if (ch !== 38 /* '&' */) {
      out += raw[i]!;
      i++;
      continue;
    }
    const semi = raw.indexOf(';', i);
    if (semi < 0) {
      // Lone `&` without a closing `;`: emit as-is.
      out += '&';
      i++;
      continue;
    }
    const ent = raw.slice(i + 1, semi);
    let replacement: string | null = null;
    if (ent === 'amp') replacement = '&';
    else if (ent === 'lt') replacement = '<';
    else if (ent === 'gt') replacement = '>';
    else if (ent === 'quot') replacement = '"';
    else if (ent === 'apos') replacement = "'";
    else if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = parseInt(ent.slice(2), 16);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        replacement = String.fromCodePoint(cp);
      }
    } else if (ent.startsWith('#')) {
      const cp = parseInt(ent.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        replacement = String.fromCodePoint(cp);
      }
    }
    if (replacement === null) {
      out += raw.slice(i, semi + 1);
    } else {
      out += replacement;
    }
    i = semi + 1;
  }
  return out;
}

/**
 * Compose the final element value from attributes, children, and
 * accumulated text. Three shapes match fast-xml-parser's behavior:
 *   - No attributes, no children, just text -> bare string.
 *   - Attributes + text but no children -> object with `#text`
 *     and `@_attr` keys.
 *   - Anything with children -> object keyed by child name; same-
 *     named children collapse into an array.
 */
function finishElement(
  attrs: Record<string, string>,
  children: Array<{ name: string; value: XmlValue }>,
  textBuf: string | null,
): XmlValue {
  const trimmedText = textBuf !== null ? decodeEntities(textBuf).trim() : '';
  const hasAttrs = Object.keys(attrs).length > 0;
  const hasChildren = children.length > 0;
  const hasText = trimmedText.length > 0;

  if (!hasAttrs && !hasChildren) {
    // Text-only element (or empty): emit the text directly. The
    // old parser used `''` for empty elements; mirror that.
    return trimmedText;
  }
  if (!hasChildren) {
    // Attributes + (maybe) text: object with #text and attrs.
    const obj: XmlElement = { ...attrs };
    if (hasText) obj['#text'] = trimmedText;
    return obj;
  }

  // Element with children. Collect children by name; on collision,
  // promote to an array.
  const obj: XmlElement = { ...attrs };
  if (hasText) obj['#text'] = trimmedText;
  for (const c of children) {
    const existing = obj[c.name];
    if (existing === undefined) {
      obj[c.name] = c.value;
    } else if (Array.isArray(existing)) {
      existing.push(c.value);
    } else {
      obj[c.name] = [existing, c.value];
    }
  }
  return obj;
}
