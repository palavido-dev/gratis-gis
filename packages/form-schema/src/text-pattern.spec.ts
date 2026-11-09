// SPDX-License-Identifier: AGPL-3.0-or-later
import { validate, type FormSchema, type Question } from './index.js';

/**
 * A text question's `pattern` is author input. An uncompilable one
 * used to throw a SyntaxError out of validate(), which the server
 * turned into a 500 on every non-empty answer, so offline queues
 * retried forever. It now follows the `regex` type's rule: a bad
 * pattern is a designer error and the answer passes.
 */
function form(questions: Question[]): FormSchema {
  return { schemaVersion: 1, id: 'f', title: 'T', questions } as unknown as FormSchema;
}

describe('text pattern', () => {
  it('does not throw on a pattern that does not compile', () => {
    const f = form([{ id: 'code', label: 'Code', type: 'text', pattern: '[A-Z' } as Question]);
    expect(() => validate(f, { code: 'ABC' })).not.toThrow();
    expect(validate(f, { code: 'ABC' }).ok).toBe(true);
  });

  it('still enforces a pattern that compiles', () => {
    const f = form([{ id: 'code', label: 'Code', type: 'text', pattern: '[A-Z]+' } as Question]);
    expect(validate(f, { code: 'ABC' }).ok).toBe(true);
    expect(validate(f, { code: 'abc' }).ok).toBe(false);
  });
});
