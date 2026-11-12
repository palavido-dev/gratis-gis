// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An author pattern such as (a+)+ made one form submission take time
// exponential in the answer length on the API (about 3 s at 27
// characters, doubling per character). The API now validates with a
// linear-time engine.

import { setPatternMatcher, validate, matchAnchoredPattern } from '@gratis-gis/form-schema';

import { linearPatternMatcher } from './linear-pattern.js';
import { assertFormPatternsCompile } from './form-pattern-check.js';

describe('linear pattern matching for form validation', () => {
  beforeAll(() => setPatternMatcher(linearPatternMatcher));
  afterAll(() => setPatternMatcher(null));

  it('answers a catastrophic pattern at once', () => {
    const t = Date.now();
    expect(matchAnchoredPattern('(a+)+', '', 'a'.repeat(5000) + 'b')).toBe(false);
    expect(matchAnchoredPattern('(a|a)*', '', 'a'.repeat(5000) + 'b')).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('keeps ordinary semantics: anchoring and flags', () => {
    expect(matchAnchoredPattern('[A-Z]{2}\\d{3}', '', 'AB123')).toBe(true);
    expect(matchAnchoredPattern('[A-Z]{2}\\d{3}', '', 'xAB123')).toBe(false);
    expect(matchAnchoredPattern('abc', 'i', 'ABC')).toBe(true);
    expect(matchAnchoredPattern('(?=a)a', '', 'a')).toBeNull();
  });

  it('validate() on a regex question stays fast', () => {
    const form = {
      version: 1,
      questions: [{ id: 'q', type: 'regex', label: 'Q', pattern: '(a+)+', required: false }],
    };
    const t = Date.now();
    validate(form as never, { q: 'a'.repeat(40) + 'b' });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('refuses at save a pattern the server cannot run', () => {
    const form = (pattern: string) => ({ questions: [{ id: 'q1', type: 'text', pattern }] });
    expect(() => assertFormPatternsCompile(form('(?=a)a'))).toThrow(/lookahead/);
    expect(() => assertFormPatternsCompile(form('[0-9]{5}'))).not.toThrow();
  });
});
