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
import type { DataSource } from './data';
import { LENGTH_UNITS } from './geo';
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
  /** SQL for the row's feature id (uuid), for related(). */
  idSql?: string;
}

/**
 * How the host reads another source's current rows. The result must
 * be usable in FROM and yield `global_id`, `geom` and `properties`.
 * `conditions` are written against the raw columns `attrs` and
 * `geom`; the host applies them both to pick candidate rows (where an
 * index can help) and to the current version of each row. `knn` asks
 * for only the candidates nearest a geometry. The host also applies
 * the viewer's own access limits on the source.
 */
export interface SqlDataAdapter {
  rowsSql(
    source: DataSource,
    opts: { conditions: string[]; knn?: { geomSql: string; limit: number } },
    bind: (v: unknown, cast: string) => string,
  ): string;
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
  /** Reads other sources; required when the expression uses data access. */
  dataAdapter?: SqlDataAdapter;
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
  /** Static type of `sql` after any `as` conversion. */
  type: ValueType;
}

/**
 * How many nearest candidates the spatial index offers before exact
 * distances pick the closest. The index ranks every stored version of
 * a row, so old versions can take places; 64 leaves room.
 */
export const NEAREST_CANDIDATES = 64;

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
  /** Row contexts: the outer feature first, then rows of data functions. */
  const rows: SqlRowContext[] = [opts.row];
  const inRow = <T>(ctx: SqlRowContext, f: () => T): T => {
    rows.push(ctx);
    try {
      return f();
    } finally {
      rows.pop();
    }
  };
  let aliasCounter = 0;

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
      case 'field': {
        const row = e.outer ? rows[0]! : rows[rows.length - 1]!;
        return fieldSql(row.propertiesSql, e.name, i.fieldType ?? 'unknown');
      }
      case 'member': {
        const alias = nextAlias();
        const from = featureFrom(e.object, alias);
        return `(SELECT ${fieldSql(`${alias}.properties`, e.name, i.fieldType ?? 'unknown')} FROM ${from})`;
      }
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
    if (i.data) return emitData(e, i);
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
      if (kind === 'feature' && info(x).data) {
        const alias = nextAlias();
        return { sql: `(SELECT ${alias}.geom FROM ${featureFrom(x, alias)})`, type: 'feature' as ValueType };
      }
      const ax = arg(x);
      if (kind === 'any' || kind === 'feature') return ax;
      const to = typeAfter(kind, ax.type);
      return { sql: ax.type === 'null' ? `NULL::${sqlTypeName(to)}` : sqlAs(ax, to), type: to };
    });
    return v.sql(sqlArgs, fnCtx);
  }

  // ---- data access ----------------------------------------------

  function nextAlias(): string {
    aliasCounter += 1;
    return `gx${aliasCounter}`;
  }

  interface Plan {
    source: DataSource;
    conditions: string[];
    /** Sort keys; built per alias, since they name the alias. */
    order: Array<(alias: string) => string>;
    limit: number | null;
    knn?: { geomSql: string; limit: number };
    reversed: boolean;
  }

  function outerGeom(pos: number): string {
    if (!opts.row.geomSql) throw new ExpressionError('This feature has no geometry to measure from', pos);
    return opts.row.geomSql;
  }

  /** Raw-row context for conditions: candidate and current rows alike. */
  const RAW: SqlRowContext = { propertiesSql: 'attrs', geomSql: 'geom', idSql: 'entity' };

  function metersSql(amount: string, unit: string): string {
    return `((${amount}) * ${sqlNumLit(LENGTH_UNITS[unit] ?? 1)})`;
  }

  function nearCondition(g: string, meters: string): string {
    return `(geom && ST_Expand(${g}, ${meters} / 111320.0 / greatest(cos(radians(ST_Y(ST_Centroid(${g})))), 0.05)) AND ST_DWithin(geom::geography, (${g})::geography, ${meters}, false))`;
  }

  function planOf(e: Expr): Plan {
    const i = info(e);
    if (e.kind !== 'func' || !i.data) {
      throw new ExpressionError('Expected rows from related(), layer() or a data function', e.pos);
    }
    const a = e.args;
    switch (i.data) {
      case 'related':
      case 'layer': {
        const source = i.set?.source;
        if (!source) throw new ExpressionError('Unresolved data source', e.pos);
        const conditions: string[] = [];
        if (i.data === 'related') {
          const fk = source.parentFk;
          const id = rows[0]!.idSql;
          if (!fk || !isSqlSafeFieldName(fk)) throw new ExpressionError(`${source.label} has no parent key`, e.pos);
          if (!id) throw new ExpressionError('related() needs the feature id here', e.pos);
          conditions.push(`(attrs @> jsonb_build_object('${fk}', (${id})::text))`);
        }
        return { source, conditions, order: [], limit: null, reversed: false };
      }
      case 'filter': {
        const p = planOf(a[0]!);
        p.conditions.push(inRow(RAW, () => pred(a[1]!)));
        return p;
      }
      case 'order_by': {
        const p = planOf(a[0]!);
        const dir = i.lits![2] === 'desc' ? 'DESC' : 'ASC';
        const t = info(a[1]!).type;
        p.order = [
          (alias) => {
            const v = inRow(rowCtx(alias), () => emit(a[1]!));
            const collate = t === 'string' || t === 'unknown' ? ' COLLATE "C"' : '';
            return `${v}${collate} ${dir} NULLS LAST`;
          },
        ];
        p.reversed = false;
        return p;
      }
      case 'top': {
        const p = planOf(a[0]!);
        p.limit = p.limit === null ? (i.lits![1] as number) : Math.min(p.limit, i.lits![1] as number);
        return p;
      }
      case 'within_distance': {
        const p = planOf(a[0]!);
        const g = outerGeom(e.pos);
        p.conditions.push(nearCondition(g, metersSql(sqlNum(arg(a[1]!)), i.lits![2] as string)));
        return p;
      }
      case 'intersecting':
      case 'containing':
      case 'within': {
        const p = planOf(a[0]!);
        const g = outerGeom(e.pos);
        const fn = i.data === 'intersecting' ? 'ST_Intersects' : i.data === 'containing' ? 'ST_Covers' : 'ST_CoveredBy';
        p.conditions.push(`(geom && (${g}) AND ${fn}(geom, ${g}))`);
        return p;
      }
      default:
        throw new ExpressionError(`${i.data}() does not return rows`, e.pos);
    }
  }

  function rowCtx(alias: string): SqlRowContext {
    return { propertiesSql: `${alias}.properties`, geomSql: `${alias}.geom`, idSql: `${alias}.global_id` };
  }

  function orderClause(p: Plan, alias: string): string {
    const keys = p.order.map((k) => k(alias));
    keys.push(`${alias}.global_id ASC`);
    const flipped = p.reversed
      ? keys.map((k) =>
          k.endsWith(' ASC NULLS LAST')
            ? k.replace(/ ASC NULLS LAST$/, ' DESC NULLS FIRST')
            : k.endsWith(' DESC NULLS LAST')
              ? k.replace(/ DESC NULLS LAST$/, ' ASC NULLS FIRST')
              : k.replace(/ ASC$/, ' DESC'),
        )
      : keys;
    return flipped.join(', ');
  }

  /** `(...) alias` with the plan's rows, ordered and limited. */
  function fromPlan(p: Plan, alias: string, limit: number | null = p.limit): string {
    if (!opts.dataAdapter) throw new ExpressionError('Reading other rows is not available here', root.pos);
    const inner = opts.dataAdapter.rowsSql(
      p.source,
      p.knn ? { conditions: p.conditions, knn: p.knn } : { conditions: p.conditions },
      bind,
    );
    const lim = limit === null ? '' : ` LIMIT ${limit}`;
    return `(SELECT ${alias}.* FROM (${inner}) ${alias} ORDER BY ${orderClause(p, alias)}${lim}) ${alias}`;
  }

  /** The one row a feature-valued data function picks, as `FROM`. */
  function featureFrom(e: Expr, alias: string): string {
    const i = info(e);
    if (e.kind !== 'func' || !i.data) throw new ExpressionError('Expected a feature', e.pos);
    const a = e.args;
    if (i.data === 'first' || i.data === 'last') {
      const p = planOf(a[0]!);
      if (i.data === 'last') {
        if (p.limit !== null) throw new ExpressionError('last() of top() is not supported; use order_by() with desc', e.pos);
        p.reversed = true;
      }
      return fromPlan(p, alias, 1);
    }
    if (i.data === 'nearest') {
      const p = planOf(a[0]!);
      const g = outerGeom(e.pos);
      if (a[1]) p.conditions.push(nearCondition(g, metersSql(sqlNum(arg(a[1])), i.lits![2] as string)));
      p.knn = { geomSql: g, limit: NEAREST_CANDIDATES };
      p.order = [(al) => `ST_Distance(${al}.geom::geography, (${g})::geography, false) ASC NULLS LAST`];
      return fromPlan(p, alias, 1);
    }
    throw new ExpressionError(`${i.data}() does not return a feature`, e.pos);
  }

  function emitData(e: Extract<Expr, { kind: 'func' }>, i: NodeInfo): string {
    const a = e.args;
    const alias = nextAlias();
    switch (i.data) {
      case 'count':
        return `(SELECT count(*) FROM ${fromPlan(planOf(a[0]!), alias)})::double precision`;
      case 'exists':
        return `EXISTS (SELECT 1 FROM ${fromPlan(planOf(a[0]!), alias)})`;
      case 'sum':
      case 'avg': {
        const v = inRow(rowCtx(alias), () => sqlNum(arg(a[1]!)));
        const agg = i.data === 'sum' ? `COALESCE(sum(${v}), 0)` : `avg(${v})`;
        return `(SELECT ${agg} FROM ${fromPlan(planOf(a[0]!), alias)})`;
      }
      case 'min':
      case 'max': {
        const dom = i.domain!;
        const v = inRow(rowCtx(alias), () => {
          const x = arg(a[1]!);
          return dom === 'number' ? sqlNum(x) : dom === 'date' ? sqlDate(x) : dom === 'boolean' ? sqlBool(x) : sqlText(x);
        });
        const agg =
          dom === 'boolean'
            ? `${i.data === 'min' ? 'bool_and' : 'bool_or'}(${v})`
            : `${i.data}(${v}${dom === 'text' ? ' COLLATE "C"' : ''})`;
        return `(SELECT ${agg} FROM ${fromPlan(planOf(a[0]!), alias)})`;
      }
      case 'count_distinct': {
        const v = inRow(rowCtx(alias), () => sqlText(arg(a[1]!)));
        return `(SELECT count(DISTINCT ${v}) FROM ${fromPlan(planOf(a[0]!), alias)})::double precision`;
      }
      case 'list': {
        const p = planOf(a[0]!);
        const v = inRow(rowCtx(alias), () => sqlText(arg(a[1]!)));
        const sep = a[2] ? sqlText(arg(a[2])) : `', '`;
        return `(SELECT COALESCE(string_agg(${v}, ${sep} ORDER BY ${orderClause(p, alias)}), '') FROM ${fromPlan(p, alias)})`;
      }
      case 'lookup': {
        const p = planOf(a[0]!);
        const key = i.lits![1] as string;
        const ret = i.lits![3] as string;
        if (!isSqlSafeFieldName(key) || !isSqlSafeFieldName(ret)) throw new ExpressionError('Field name not allowed', e.pos);
        const v = sqlText(arg(a[2]!));
        p.conditions.push(`((attrs->>'${key}') = ${v})`);
        return `(SELECT ${fieldSql(`${alias}.properties`, ret, i.fieldType ?? 'unknown')} FROM ${fromPlan(p, alias, 1)})`;
      }
      case 'distance_to': {
        const p = planOf(a[0]!);
        const g = outerGeom(e.pos);
        p.knn = { geomSql: g, limit: NEAREST_CANDIDATES };
        const unit = LENGTH_UNITS[i.lits![1] as string] ?? 1;
        return `(SELECT min(ST_Distance(${alias}.geom::geography, (${g})::geography, false)) / ${sqlNumLit(unit)} FROM ${fromPlan(p, alias)})`;
      }
      default:
        throw new ExpressionError(`${i.data}() returns rows; summarize them with count() or read one with first()`, e.pos);
    }
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
