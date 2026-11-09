// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { assertFormPatternsCompile } from './form-pattern-check.js';

describe('assertFormPatternsCompile', () => {
  it('accepts valid patterns and non-form data', () => {
    expect(() =>
      assertFormPatternsCompile({
        questions: [
          { id: 'a', type: 'text', pattern: '[0-9]{3}' },
          { id: 'b', type: 'regex', pattern: 'x+', flags: 'i' },
        ],
      }),
    ).not.toThrow();
    expect(() => assertFormPatternsCompile(null)).not.toThrow();
    expect(() => assertFormPatternsCompile({ note: 1 })).not.toThrow();
  });

  it('names every question whose pattern does not compile, including nested ones', () => {
    let caught: unknown;
    try {
      assertFormPatternsCompile({
        questions: [
          { id: 'top', type: 'text', pattern: '[A-Z' },
          {
            id: 'grp',
            type: 'group',
            repeat: {},
            children: [{ id: 'inner', type: 'regex', pattern: '(?<=a', flags: '' }],
          },
          { id: 'flags', type: 'regex', pattern: 'a', flags: 'zz' },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as Error).message).toContain('top, inner, flags');
  });
});
