// SPDX-License-Identifier: AGPL-3.0-or-later
import { evaluate, type Expression } from '@gratis-gis/form-schema';
import {
  DEFAULT_ROW,
  decomposeExpression,
  rowToExpression,
  treeFromExpression,
  treeToExpression,
  type ConditionRow,
} from './form-designer-conditions';

const row = (over: Partial<ConditionRow>): ConditionRow => ({ ...DEFAULT_ROW(), ...over });

describe('contains row', () => {
  const expr = rowToExpression(row({ ref: 'species', op: 'in', value: 'oak' }));

  it('is true when the text answer contains the value', () => {
    expect(evaluate(expr, { species: 'red oak' })).toBe(true);
    expect(evaluate(expr, { species: 'pine' })).toBe(false);
  });

  it('tests a checkbox answer for the picked value', () => {
    const e = rowToExpression(row({ ref: 'boxes', op: 'in', value: '2' }));
    expect(evaluate(e, { boxes: ['1', '2'] })).toBe(true);
    expect(evaluate(e, { boxes: ['1'] })).toBe(false);
  });

  it('round-trips through the row editor', () => {
    expect(decomposeExpression(expr)?.rows[0]).toEqual(
      row({ ref: 'species', op: 'in', value: 'oak' }),
    );
  });

  it('reads the old reversed shape as a contains row', () => {
    const old: Expression = { op: 'in', left: { ref: 'species' }, right: { value: 'oak' } };
    const r = decomposeExpression(old)!.rows[0]!;
    expect(evaluate(rowToExpression(r), { species: 'red oak' })).toBe(true);
  });
});

describe('not-empty row', () => {
  const expr = rowToExpression(row({ ref: 'q', op: 'notEmpty' }));

  it('is false for an unanswered question and true once answered', () => {
    expect(evaluate(expr, {})).toBe(false);
    expect(evaluate(expr, { q: '' })).toBe(false);
    expect(evaluate(expr, { q: 'x' })).toBe(true);
    expect(evaluate(expr, { q: [] })).toBe(false);
    expect(evaluate(expr, { q: ['a'] })).toBe(true);
  });

  it('round-trips', () => {
    expect(decomposeExpression(expr)?.rows[0]?.op).toBe('notEmpty');
  });
});

describe('Builder round trip', () => {
  it('keeps operands the rows cannot show', () => {
    const calc: Expression = {
      op: 'mul',
      left: { ref: 'a' },
      right: { value: 2 },
    };
    expect(treeToExpression(treeFromExpression(calc))).toEqual(calc);

    const mixed: Expression = {
      op: 'and',
      operands: [
        { op: 'eq', left: { ref: 'a' }, right: { value: 'x' } },
        { op: 'not', operand: { op: 'eq', left: { ref: 'b' }, right: { value: 'y' } } },
        { op: 'eq', left: { ref: 'a' }, right: { ref: 'b' } },
      ],
    };
    expect(treeToExpression(treeFromExpression(mixed))).toEqual(mixed);
  });

  it('keeps regex flags', () => {
    const m: Expression = {
      op: 'matches',
      left: { ref: 'a' },
      right: { value: 'abc' },
      flags: 'i',
    };
    expect(treeToExpression(treeFromExpression(m))).toEqual(m);
    const r = decomposeExpression(m)!.rows[0]!;
    expect(rowToExpression(r)).toEqual(m);
  });
});
