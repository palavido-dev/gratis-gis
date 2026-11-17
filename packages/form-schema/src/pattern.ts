// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Matching for form authors' patterns (Pattern and Regex questions,
 * the `matches` operator), anchored at both ends as in XLSForm.
 *
 * Patterns are written by authors, and for `matches` can come from
 * another answer. The platform RegExp backtracks: `(a+)+` with a 40
 * character answer takes minutes, which on the API stalled the whole
 * server for one submission. RE2 (re2js, a pure JavaScript port) runs
 * in time linear in the answer everywhere this package runs: browser,
 * server and the field engine. It has no lookaround or
 * backreferences; the API refuses such patterns when a form is saved,
 * and one stored earlier counts as invalid, which validation lets
 * through as before.
 */
import { RE2JS } from 're2js';

const cache = new Map<string, RE2JS | null>();
const CACHE_MAX = 500;

function flagBits(flags: string): number | null {
  let bits = 0;
  for (const f of flags) {
    if (f === 'i') bits |= RE2JS.CASE_INSENSITIVE;
    else if (f === 'm') bits |= RE2JS.MULTILINE;
    else if (f === 's') bits |= RE2JS.DOTALL;
    else if (f === 'u' || f === 'g' || f === 'y' || f === 'd') continue;
    else return null;
  }
  return bits;
}

/** Compile `^(?:pattern)$`, or null when RE2 cannot. Cached. */
export function compileAnchoredPattern(pattern: string, flags: string): RE2JS | null {
  const key = `${flags}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let compiled: RE2JS | null = null;
  const bits = flagBits(flags);
  if (bits !== null) {
    try {
      compiled = RE2JS.compile(`^(?:${pattern})$`, bits);
    } catch {
      compiled = null;
    }
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/**
 * True or false for a match; null when the pattern cannot be compiled
 * (a designer error, which callers let through). Never throws.
 */
export function matchAnchoredPattern(pattern: string, flags: string, subject: string): boolean | null {
  const re = compileAnchoredPattern(pattern, flags);
  if (!re) return null;
  try {
    return re.matches(subject);
  } catch {
    return null;
  }
}
