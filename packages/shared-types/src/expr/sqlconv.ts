// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How each static type is represented in SQL, and the conversions
 * between them. The JavaScript twins are in values.ts.
 *
 *   number  -> double precision
 *   string  -> text
 *   boolean -> boolean
 *   date    -> timestamptz
 *   list    -> text[]
 *   unknown -> text (a field with no declared type)
 *
 * The gg_expr_* functions are created by the expression_functions
 * migration.
 */

import type { ValueType } from './ast';

export interface SqlArg {
  sql: string;
  type: ValueType;
  /** Normalized literal value for literal-only parameters. */
  lit?: unknown;
}

export const SQL_TYPE: Record<'number' | 'string' | 'boolean' | 'date' | 'list', string> = {
  number: 'double precision',
  string: 'text',
  boolean: 'boolean',
  date: 'timestamptz',
  list: 'text[]',
};

export function sqlNum(a: SqlArg): string {
  switch (a.type) {
    case 'number':
      return a.sql;
    case 'null':
      return 'NULL::double precision';
    case 'boolean':
      return `(${a.sql})::int::double precision`;
    case 'date':
      return `(extract(epoch from ${a.sql}) * 1000)::double precision`;
    default:
      return `gg_expr_num(${a.sql})`;
  }
}

export function sqlText(a: SqlArg): string {
  switch (a.type) {
    case 'string':
    case 'unknown':
      return a.sql;
    case 'null':
      return 'NULL::text';
    case 'number':
    case 'boolean':
      return `(${a.sql})::text`;
    case 'date':
      return `gg_expr_ts_text(${a.sql})`;
    case 'list':
      return `array_to_string(${a.sql}, ', ')`;
    default:
      return 'NULL::text';
  }
}

export function sqlDate(a: SqlArg): string {
  switch (a.type) {
    case 'date':
      return a.sql;
    case 'string':
    case 'unknown':
      return `gg_expr_ts(${a.sql})`;
    default:
      return 'NULL::timestamptz';
  }
}

export function sqlBool(a: SqlArg): string {
  switch (a.type) {
    case 'boolean':
      return a.sql;
    case 'string':
    case 'unknown':
      return `gg_expr_bool(${a.sql})`;
    case 'number':
      return `(${a.sql} <> 0)`;
    default:
      return 'NULL::boolean';
  }
}

export function sqlList(a: SqlArg): string {
  return a.type === 'list' ? a.sql : 'NULL::text[]';
}

/** Convert to the SQL representation of `to`. */
export function sqlAs(a: SqlArg, to: ValueType): string {
  switch (to) {
    case 'number':
      return sqlNum(a);
    case 'string':
      return sqlText(a);
    case 'date':
      return sqlDate(a);
    case 'boolean':
      return sqlBool(a);
    case 'list':
      return sqlList(a);
    default:
      return a.sql;
  }
}

/** A SQL number literal; always a double so `5 / 2` is 2.5. */
export function sqlNumLit(n: number): string {
  return `(${String(n)}::double precision)`;
}
