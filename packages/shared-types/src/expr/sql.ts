// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQL compiler. Turns a checked expression into a Postgres fragment
 * plus bind parameters. Text values are always bound, never inlined;
 * field names are allowlisted identifiers (names.ts) and appear only
 * as `->>'name'` literals.
 *
 * Booleans: comparisons and logic are two-valued (true or false,
 * never null) in value position, so `{{x}} == 'a'` is false when x is
 * empty, the same answer the JavaScript evaluator gives. In predicate
 * position (a WHERE clause, a CASE condition) the bare comparison is
 * emitted instead so Postgres can use an index; there null and false
 * are the same thing, so the result does not change.
 */

import type { Expr, FieldRef, ValueType } from './ast';
import { ExpressionError } from './ast';
import type { CheckResult, CompareDomain, NodeInfo } from './check';
import { typeAfter } from './check';
import { LITERAL_KINDS, type SqlFnCtx } from './catalog';
import { isSqlSafeFieldName } from './names';
import {
  sqlAs,
  sqlBool,
  sqlDate,
  sqlList,
  sqlNum,
  sqlNumLit,
  sqlText,
  type SqlArg,
} from './sqlconv';

export interface SqlRowContext {
  /** SQL for the row's attribute jsonb, such as `properties` or `o.attrs`. */
  propertiesSql: string;
  /** SQL for the row's geometry (EPSG:4326), when it has one. */
  geomSql?: string;
}

export interface SqlCompileOptions {
  row: SqlRowContext;
  /** The first parameter emitted is `$${paramOffset + 1}`. */
  paramOffset: number;
  /** IANA time zone for today(). Defaults to UTC. */
  timeZone?: string;
  /** Emit for a WHERE clause. */
  predicate?: boolean;
  /** Convert the result to this type; 'value' keeps its own type. */
  as?: 'number' | 'string' | 'boolean' | 'date' | 'list' | 'value';
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
  /** Static type of `sql` after any `as` conversion. */
  type: ValueType;
}

export function fieldSql(propertiesSql: string, name: string, type: ValueType): string {
  if (!isSqlSafeFieldName(name)) {
    throw new ExpressionError(`Field name "${name}" is not allowed in SQL`, 0);
  }
  const text = `(${propertiesSql}->>'${name}')`;
  switch (type) {
    case 'number':
      return `gg_expr_num(${text})`;
    case 'boolean':
      return `gg_expr_bool(${text})`;
    case 'date':
      return `gg_expr_ts(${text})`;
    case 'list':
      return `gg_expr_list(${propertiesSql}->'${name}')`;
    default:
      return text;
  }
}

export function compileChecked(
  root: Expr,
  checked: CheckResult,
  opts: SqlCompileOptions,
): CompiledSql {
  if (checked.issues.length > 0) {
    const first = checked.issues[0]!;
    throw new ExpressionError(first.message, first.pos);
  }
  const params: unknown[] = [];
  const bind = (v: unknown, cast: string) => {
    params.push(v);
    return `$${opts.paramOffset + params.length}::${cast}`;
  };
  let tzSql: string | null = null;
  const fnCtx: SqlFnCtx = {
    param: bind,
    get timeZone() {
      tzSql ??= bind(opts.timeZone ?? 'UTC', 'text');
      return tzSql;
    },
  };
  const info = (e: Expr): NodeInfo => {
    const i = checked.info.get(e);
    if (!i) throw new ExpressionError('Internal error: expression was not checked', e.pos);
    return i;
  };
  const arg = (e: Expr): SqlArg => ({ sql: emit(e), type: info(e).type });

  /** Two-valued boolean from any expression. */
  function boolValue(e: Expr): string {
    return `COALESCE(${sqlBool(arg(e))}, FALSE)`;
  }

  /** Boolean for a condition position, where null counts as false. */
  function pred(e: Expr): string {
    switch (e.kind) {
      case 'binop':
        if (e.op === 'AND' || e.op === 'OR') return `(${pred(e.left)} ${e.op} ${pred(e.right)})`;
        if (['==', '<', '<=', '>', '>='].includes(e.op)) {
          return compare(e.op, e.left, e.right, info(e).domain!, true);
        }
        break;
      case 'like':
        if (!e.negated) return likeRaw(e);
        break;
      case 'in':
        if (!e.negated && !info(e).member) return inRaw(e, true);
        break;
      case 'between':
        if (!e.negated) return betweenRaw(e, true);
        break;
      default:
        break;
    }
    return boolValue(e);
  }

  function side(e: Expr, domain: CompareDomain): string {
    const a = arg(e);
    switch (domain) {
      case 'number':
        return sqlNum(a);
      case 'date':
        return sqlDate(a);
      case 'boolean':
        return sqlBool(a);
      case 'list':
        return a.type === 'list' ? a.sql : `ARRAY[${sqlText(a)}]::text[]`;
      default:
        return sqlText(a);
    }
  }

  function compare(op: string, l: Expr, r: Expr, domain: CompareDomain, raw: boolean): string {
    if (domain === 'null') {
      const other = info(l).type === 'null' ? r : l;
      if (info(other).type === 'null') return op === '==' ? 'TRUE' : 'FALSE';
      return `(${emit(other)} IS ${op === '==' ? '' : 'NOT '}NULL)`;
    }
    const L = side(l, domain);
    const R = side(r, domain);
    if (op === '!=') return `(${L} IS DISTINCT FROM ${R})`;
    const sqlOp = op === '==' ? '=' : op;
    const collate = domain === 'text' && op !== '==' ? ' COLLATE "C"' : '';
    const cmp = `(${L}${collate} ${sqlOp} ${R})`;
    return raw ? cmp : `COALESCE(${cmp}, FALSE)`;
  }

  function inRaw(e: Extract<Expr, { kind: 'in' }>, raw: boolean): string {
    const i = info(e);
    if (i.member) {
      return `COALESCE(${sqlText(arg(e.arg))} = ANY(${sqlList(arg(e.list))}), FALSE)`;
    }
    const items = (e.list as Extract<Expr, { kind: 'list' }>).items;
    if (items.length === 0) return 'FALSE';
    const parts = items.map((item, k) => compare('==', e.arg, item, i.domains![k]!, true));
    const or = parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
    return raw ? or : `COALESCE(${or}, FALSE)`;
  }

  function betweenRaw(e: Extract<Expr, { kind: 'between' }>, raw: boolean): string {
    const [d1, d2] = info(e).domains as [CompareDomain, CompareDomain];
    const both = `(${compare('>=', e.arg, e.low, d1, true)} AND ${compare('<=', e.arg, e.high, d2, true)})`;
    return raw ? both : `COALESCE(${both}, FALSE)`;
  }

  function likeRaw(e: Extract<Expr, { kind: 'like' }>): string {
    return `(${sqlText(arg(e.arg))} ${e.caseInsensitive ? 'ILIKE' : 'LIKE'} ${sqlText(arg(e.pattern))})`;
  }

  /** A branch value converted to the unified result type. */
  function branch(e: Expr, to: ValueType): string {
    if (to === 'null') return 'NULL';
    const a = arg(e);
    if (a.type === 'null') return `NULL::${sqlTypeName(to)}`;
    return sqlAs(a, to);
  }

  function emit(e: Expr): string {
    const i = info(e);
    switch (e.kind) {
      case 'num':
        return sqlNumLit(e.value);
      case 'str':
        return bind(e.value, 'text');
      case 'bool':
        return e.value ? 'TRUE' : 'FALSE';
      case 'null':
        return 'NULL';
      case 'feature':
        if (!opts.row.geomSql) throw new ExpressionError('This layer has no geometry', e.pos);
        return opts.row.geomSql;
      case 'field':
        return fieldSql(opts.row.propertiesSql, e.name, i.fieldType ?? 'unknown');
      case 'member':
        throw new ExpressionError('Reading a field from another row needs data access', e.pos);
      case 'list':
        return `array_remove(ARRAY[${e.items.map((x) => sqlText(arg(x))).join(', ')}]::text[], NULL)`;
      case 'unop':
        return e.op === '-' ? `(-${sqlNum(arg(e.arg))})` : `(NOT ${boolValue(e.arg)})`;
      case 'binop': {
        switch (e.op) {
          case 'AND':
          case 'OR':
            return `(${boolValue(e.left)} ${e.op} ${boolValue(e.right)})`;
          case '==':
          case '!=':
          case '<':
          case '<=':
          case '>':
          case '>=':
            return compare(e.op, e.left, e.right, i.domain!, false);
          default:
            break;
        }
        if (i.concat) return `concat(${sqlText(arg(e.left))}, ${sqlText(arg(e.right))})`;
        const L = sqlNum(arg(e.left));
        const R = sqlNum(arg(e.right));
        switch (e.op) {
          case '/':
            return `(${L} / NULLIF(${R}, 0))`;
          case '%':
            return `(${L} - ${R} * trunc(${L} / NULLIF(${R}, 0)))`;
          default:
            return `(${L} ${e.op} ${R})`;
        }
      }
      case 'isnull':
        return `(${emit(e.arg)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
      case 'in': {
        const v = inRaw(e, false);
        return e.negated ? `(NOT ${v})` : v;
      }
      case 'between': {
        const v = betweenRaw(e, false);
        return e.negated ? `(NOT ${v})` : v;
      }
      case 'like': {
        const v = `COALESCE(${likeRaw(e)}, FALSE)`;
        return e.negated ? `(NOT ${v})` : v;
      }
      case 'case': {
        const whens = e.whens
          .map((w, k) => {
            const cond = e.subject ? compare('==', e.subject, w.when, i.domains![k]!, true) : pred(w.when);
            return `WHEN ${cond} THEN ${branch(w.then, i.type)}`;
          })
          .join(' ');
        const otherwise = e.otherwise ? ` ELSE ${branch(e.otherwise, i.type)}` : '';
        return `(CASE ${whens}${otherwise} END)`;
      }
      case 'func':
        return emitFunc(e, i);
    }
  }

  function emitFunc(e: Extract<Expr, { kind: 'func' }>, i: NodeInfo): string {
    const a = e.args;
    switch (i.variant ? '' : canonicalSpecial(e.name)) {
      case 'if':
        return `(CASE WHEN ${pred(a[0]!)} THEN ${branch(a[1]!, i.type)} ELSE ${branch(a[2]!, i.type)} END)`;
      case 'when': {
        const parts: string[] = [];
        for (let k = 0; k + 1 < a.length; k += 2) {
          parts.push(`WHEN ${pred(a[k]!)} THEN ${branch(a[k + 1]!, i.type)}`);
        }
        return `(CASE ${parts.join(' ')} ELSE ${branch(a[a.length - 1]!, i.type)} END)`;
      }
      case 'decode': {
        const parts: string[] = [];
        let d = 0;
        for (let k = 1; k + 1 < a.length; k += 2) {
          parts.push(`WHEN ${compare('==', a[0]!, a[k]!, i.domains![d]!, true)} THEN ${branch(a[k + 1]!, i.type)}`);
          d += 1;
        }
        return `(CASE ${parts.join(' ')} ELSE ${branch(a[a.length - 1]!, i.type)} END)`;
      }
      case 'coalesce':
        return `COALESCE(${a.map((x) => branch(x, i.type)).join(', ')})`;
      case 'is_empty': {
        const x = arg(a[0]!);
        if (x.type === 'string' || x.type === 'unknown') return `(${x.sql} IS NULL OR ${x.sql} = '')`;
        if (x.type === 'list') return `(${x.sql} IS NULL OR cardinality(${x.sql}) = 0)`;
        return `(${x.sql} IS NULL)`;
      }
      default:
        break;
    }
    const v = i.variant!;
    const sqlArgs: SqlArg[] = a.map((x, k) => {
      const kind = i.argKinds![k]!;
      if (LITERAL_KINDS.has(kind)) return { sql: '', type: 'string', lit: i.lits![k] };
      const ax = arg(x);
      if (kind === 'any' || kind === 'feature') return ax;
      const to = typeAfter(kind, ax.type);
      return { sql: ax.type === 'null' ? `NULL::${sqlTypeName(to)}` : sqlAs(ax, to), type: to };
    });
    return v.sql(sqlArgs, fnCtx);
  }

  let sql = opts.predicate ? pred(root) : emit(root);
  let type = info(root).type;
  if (!opts.predicate && opts.as && opts.as !== 'value' && opts.as !== type) {
    sql = type === 'null' ? `NULL::${sqlTypeName(opts.as)}` : sqlAs({ sql, type }, opts.as);
    type = opts.as;
  }
  return { sql, params, type: opts.predicate ? 'boolean' : type };
}

const SPECIAL = new Map([
  ['if', 'if'],
  ['iif', 'if'],
  ['when', 'when'],
  ['decode', 'decode'],
  ['coalesce', 'coalesce'],
  ['defaultvalue', 'coalesce'],
  ['is_empty', 'is_empty'],
  ['isempty', 'is_empty'],
]);
export function canonicalSpecial(name: string): string {
  return SPECIAL.get(name) ?? '';
}

export function sqlTypeName(t: ValueType): string {
  switch (t) {
    case 'number':
      return 'double precision';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'timestamptz';
    case 'list':
      return 'text[]';
    default:
      return 'text';
  }
}

export type { FieldRef };
