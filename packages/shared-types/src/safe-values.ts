// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small validators for author-controlled values that end up in a
 * navigation call or in hand-built markup. Web and portal-api share
 * them so the save-time check and the render-time check agree.
 */
import { safeHttpHref } from './attribution-html';

// Matching control characters is the point here (browsers strip them
// from URLs before reading the scheme), so no-control-regex is wrong.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * A URL a tool may navigate to: an app-relative path (`/items/...`)
 * or an absolute http(s) URL. Anything else, including `javascript:`,
 * `data:` and protocol-relative `//host`, returns null.
 *
 * An empty string also returns null; callers treat that as "nothing
 * to do", which is the documented meaning of an empty open-url.
 */
export function safeNavigationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.replace(CONTROL_CHARS, '').trim();
  if (normalized.length === 0) return null;
  if (normalized.startsWith('/')) {
    // `//host` and `/\host` are both read by browsers as another
    // origin, so only a single leading slash counts as relative.
    const second = normalized.charAt(1);
    if (second === '/' || second === '\\') return null;
    return normalized;
  }
  return safeHttpHref(normalized);
}

/**
 * Characters a CSS color can contain in any syntax the style editor
 * produces or a person would type: hex, names, rgb()/hsl() in comma
 * or space form, `/ alpha`, percentages. The point is what it leaves
 * out: quotes, angle brackets, backslash, `;`, `{}` and `&` can never
 * appear in a color, and any one of them is enough to break out of an
 * SVG attribute or a style declaration.
 */
const SAFE_CSS_COLOR = /^[#a-zA-Z0-9(),.%\s/+-]{1,64}$/;

export function isSafeCssColor(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CSS_COLOR.test(value);
}

/** The color when it passes `isSafeCssColor`, otherwise `fallback`. */
export function safeCssColor(value: unknown, fallback: string): string {
  return isSafeCssColor(value) ? value : fallback;
}

/**
 * Walk a map item's `layers` and return the path of every string that
 * sits under a color key (`color`, `strokeColor`, `haloColor`,
 * `defaultColor`, entries of `colors`, ...) and fails
 * `isSafeCssColor`. portal-api rejects a map save that returns any
 * path, so a hostile color never reaches a renderer.
 */
export function findUnsafeMapColors(data: unknown): string[] {
  const out: string[] = [];
  if (data === null || typeof data !== 'object') return out;
  const layers = (data as { layers?: unknown }).layers;
  walkColors(layers, 'layers', false, out, 0);
  return out;
}

/** `color`, `strokeColor`, `haloColor`, `defaultColor`, ... */
const COLOR_KEY = /colou?r$/i;
/** `colors`: a list of colors (class breaks, palettes). */
const COLOR_LIST_KEY = /colou?rs$/i;
const MAX_DEPTH = 16;

function walkColors(
  value: unknown,
  path: string,
  underColorKey: boolean,
  out: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || out.length >= 20) return;
  if (typeof value === 'string') {
    // An empty string is a cleared color field, which renderers
    // already treat as "use the default". It cannot break out of
    // anything, and rejecting it would 400 every later save of a map
    // that has one.
    if (underColorKey && value !== '' && !isSafeCssColor(value)) out.push(path);
    return;
  }
  if (Array.isArray(value)) {
    // Only a `colors` list passes the flag down to its entries. An
    // array under a singular color key would be an expression, and
    // its operands are not colors.
    value.forEach((entry, i) =>
      walkColors(entry, `${path}[${i}]`, underColorKey, out, depth + 1),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const isColor = Array.isArray(child)
      ? COLOR_LIST_KEY.test(key)
      : COLOR_KEY.test(key);
    walkColors(child, `${path}.${key}`, isColor, out, depth + 1);
  }
}
