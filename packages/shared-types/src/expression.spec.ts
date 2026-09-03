// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  evaluateExpression,
  fieldRefTypeFor,
  parseExpression,
  validateExpression,
  type FieldRef,
} from './expression.js';

/**
 * The type-checker's rules for dates and lists, and the evaluator's
 * agreement with the SQL emitter on text ordering. Both used to be
 * gaps: date and multi_select fields were recorded as 'unknown', which
 * short-circuits every check, and the JS evaluator Number-coerced both
 * sides of `<`, so a date filter said yes in SQL and no in the preview.
 */

const SCHEMA: FieldRef[] = [
  { name: 'acres', type: 'number' },
  { name: 'owner', type: 'string' },
  { name: 'sampled', type: 'date' },
  { name: 'tags', type: 'list' },
  { name: 'active', type: 'boolean' },
];

const check = (src: string) => validateExpression(parseExpression(src), SCHEMA);

describe('fieldRefTypeFor', () => {
  it('maps every declared field type, with multi_select becoming list', () => {
    expect(fieldRefTypeFor('string')).toBe('string');
    expect(fieldRefTypeFor('number')).toBe('number');
    expect(fieldRefTypeFor('boolean')).toBe('boolean');
    expect(fieldRefTypeFor('date')).toBe('date');
    expect(fieldRefTypeFor('multi_select')).toBe('list');
  });
});

describe('validateExpression: dates', () => {
  it('lets a date compare with a date or with text', () => {
    expect(check('{{sampled}} < {{sampled}}')).toEqual([]);
    expect(check("{{sampled}} >= '2020-01-01'")).toEqual([]);
    expect(check("'2020-01-01' == {{sampled}}")).toEqual([]);
  });

  it('refuses arithmetic on a date with a sentence, instead of NaN later', () => {
    const errors = check('{{sampled}} - 1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\{\{sampled\}\} is a date and cannot be used in arithmetic/);
  });

  it('refuses comparing a date with a number', () => {
    expect(check('{{sampled}} > 2020')).toHaveLength(1);
  });
});

describe('validateExpression: lists', () => {
  it('allows == and != against text only', () => {
    expect(check("{{tags}} == 'oak'")).toEqual([]);
    expect(check("'oak' != {{tags}}")).toEqual([]);
    expect(check("{{tags}} < 'oak'")).toHaveLength(1);
    expect(check('{{tags}} == 3')).toHaveLength(1);
    expect(check('{{tags}} == {{tags}}')).toHaveLength(1);
  });

  it('refuses arithmetic on a list', () => {
    expect(check('{{tags}} * 2')[0]).toMatch(/is a list and cannot be used in arithmetic/);
  });
});

describe('validateExpression: text arithmetic', () => {
  it('finally catches acres + name, which its docblock has always named as the goal', () => {
    const errors = check('{{acres}} + {{owner}}');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\{\{owner\}\} is a string and cannot be used in arithmetic; use concat\(\)/);
  });

  it('still allows number arithmetic and text concatenation', () => {
    expect(check('{{acres}} * 2 + 1')).toEqual([]);
    expect(check("{{owner}} ~~ ' (verified)'")).toEqual([]);
    expect(check("concat({{owner}}, '!')")).toEqual([]);
  });

  it('leaves unknown-typed fields unchecked, as before', () => {
    const loose: FieldRef[] = [{ name: 'x', type: 'unknown' }];
    expect(validateExpression(parseExpression('{{x}} + 1'), loose)).toEqual([]);
  });
});

describe('evaluateExpression: text ordering', () => {
  const props = { sampled: '2021-06-01', owner: 'Baker', acres: 12 };
  const run = (src: string) => evaluateExpression(parseExpression(src), props);

  it('orders two ISO dates as text, agreeing with the SQL emitter', () => {
    expect(run("{{sampled}} > '2020-12-31'")).toBe(true);
    expect(run("{{sampled}} < '2021-01-01'")).toBe(false);
    expect(run("{{sampled}} >= '2021-06-01'")).toBe(true);
  });

  it('orders text as text', () => {
    expect(run("{{owner}} < 'Carter'")).toBe(true);
  });

  it('still orders numbers numerically, including numeric text against a number', () => {
    expect(run('{{acres}} > 9')).toBe(true);
    expect(evaluateExpression(parseExpression('{{n}} > 9'), { n: '12' })).toBe(true);
  });
});
