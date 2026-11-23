// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Syntax tree back to text, in the house style: `{{field}}`,
 * single-quoted text, upper-case keywords. Used by translators (the
 * Arcade importer) that rewrite a tree and need an expression a person
 * can read and edit afterwards.
 */

import type { BinOp, Expr } from './ast';

const PREC: Record<BinOp, number> = {
  OR: 1,
  AND: 2,
  '==': 4,
  '!=': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '~~': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function prec(e: Expr): number {
  switch (e.kind) {
    case 'binop':
      return PREC[e.op];
    case 'unop':
      return e.op === 'NOT' ? 3 : 8;
    case 'isnull':
    case 'in':
    case 'between':
    case 'like':
      return 4;
    default:
      return 9;
  }
}

export function printExpression(e: Expr): string {
  const wrap = (child: Expr, min: number) => {
    const t = printExpression(child);
    return prec(child) < min ? `(${t})` : t;
  };
  switch (e.kind) {
    case 'num':
      return String(e.value);
    case 'str':
      return quote(e.value);
    case 'bool':
      return e.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'field':
      return e.outer ? `$feature.${e.name}` : `{{${e.name}}}`;
    case 'feature':
      return '$feature';
    case 'member':
      return `${wrap(e.object, 9)}.${e.name}`;
    case 'list':
      return `[${e.items.map(printExpression).join(', ')}]`;
    case 'unop':
      return e.op === 'NOT' ? `NOT ${wrap(e.arg, 3)}` : `-${wrap(e.arg, 8)}`;
    case 'binop': {
      const p = PREC[e.op];
      // Left-associative: the right side needs parentheses at equal precedence.
      return `${wrap(e.left, p)} ${e.op} ${wrap(e.right, p + 1)}`;
    }
    case 'isnull':
      return `${wrap(e.arg, 5)} IS ${e.negated ? 'NOT ' : ''}NULL`;
    case 'in':
      return `${wrap(e.arg, 5)} ${e.negated ? 'NOT ' : ''}IN ${
        e.list.kind === 'list' ? `(${e.list.items.map(printExpression).join(', ')})` : wrap(e.list, 5)
      }`;
    case 'between':
      return `${wrap(e.arg, 5)} ${e.negated ? 'NOT ' : ''}BETWEEN ${wrap(e.low, 5)} AND ${wrap(e.high, 5)}`;
    case 'like':
      return `${wrap(e.arg, 5)} ${e.negated ? 'NOT ' : ''}${e.caseInsensitive ? 'ILIKE' : 'LIKE'} ${wrap(e.pattern, 5)}`;
    case 'case': {
      const parts = ['CASE'];
      if (e.subject) parts.push(printExpression(e.subject));
      for (const w of e.whens) parts.push(`WHEN ${printExpression(w.when)} THEN ${printExpression(w.then)}`);
      if (e.otherwise) parts.push(`ELSE ${printExpression(e.otherwise)}`);
      parts.push('END');
      return parts.join(' ');
    }
    case 'func':
      return `${e.name}(${e.args.map(printExpression).join(', ')})`;
  }
}
