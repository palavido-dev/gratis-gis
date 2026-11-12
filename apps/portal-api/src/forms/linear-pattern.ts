// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Linear-time matching for form authors' patterns.
 *
 * Form validation runs on the API for every submission, and the
 * patterns (Pattern questions, Regex questions, the `matches`
 * condition) are written by authors, and for `matches` can even come
 * from another answer. With the platform RegExp, a backtracking
 * engine, `(a+)+` and a 40 character answer stall the process for
 * minutes. RE2 (re2js, a pure JS port) runs in time linear in the
 * answer, at the price of not supporting lookaround and
 * backreferences. Those features are refused when a form is saved
 * (form-pattern-check.ts); a pattern already stored with them is
 * treated like any other invalid pattern, which validation lets
 * through.
 */
import { RE2JS } from 're2js';
import type { PatternMatcher } from '@gratis-gis/form-schema';

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
export function compileLinearPattern(pattern: string, flags: string): RE2JS | null {
  const key = `${flags}\u0000${pattern}`;
  if (cache.has(key)) return cache.get(key)!;
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

export const linearPatternMatcher: PatternMatcher = (pattern, flags, subject) => {
  const re = compileLinearPattern(pattern, flags);
  if (!re) return null;
  try {
    return re.matches(subject);
  } catch {
    return null;
  }
};
