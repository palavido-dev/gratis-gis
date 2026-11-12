// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FormSchema } from '@gratis-gis/form-schema';

import { cleanSubmission } from './submission-clean.js';

// B depends on A, and A is itself calculated. B is listed first so a
// single pass would read the A the client sent.
const FORM = {
  schemaVersion: 1,
  id: 'f',
  title: 'Chain',
  questions: [
    {
      id: 'b',
      type: 'calculated',
      label: 'Pass',
      calculate: {
        op: 'if',
        condition: { op: 'gte', left: { ref: 'a' }, right: { value: 10 } },
        then: { value: 'pass' },
        else: { value: 'fail' },
      },
    },
    {
      id: 'a',
      type: 'calculated',
      label: 'Total',
      calculate: { op: 'add', left: { ref: 'x' }, right: { ref: 'y' } },
    },
    { id: 'x', type: 'number', label: 'X' },
    { id: 'y', type: 'number', label: 'Y' },
  ],
} as unknown as FormSchema;

describe('cleanSubmission', () => {
  it('derives chained calculated answers from recomputed values, not client ones', () => {
    const out = cleanSubmission(FORM, { x: 6, y: 6, a: 0, b: 'fail' });
    expect(out.a).toBe(12);
    expect(out.b).toBe('pass');
  });
});
