// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * JavaScript evaluator: the browser preview and the offline field
 * app. It follows the decisions the checker recorded and the rules in
 * values.ts, so it returns what the SQL compiler's query returns.
 */

import type { Expr, FieldRefType, ValueType } from './ast';
import { ExpressionError } from './ast';
import type { CheckResult, CompareDomain, NodeInfo } from './check';
import { LITERAL_KINDS, type JsFnCtx } from './catalog';
import { canonicalSpecial } from './sql';
import {
  dateText,
  isDate,
  likeToRegExp,
  readField,
  toBool,
  toDate,
  toList,
  toNum,
  toText,
  type FeatureVal,
  type Val,
} from './values';

export interface EvalEnv {
  /** The feature the expression is evaluated for. */
  feature: FeatureVal;
  /** Milliseconds since the epoch; defaults to Date.now(). */
  now?: number;
  /** IANA time zone for today(); defaults to UTC. */
  timeZone?: string;
}

function convert(v: Val, to: ValueType): Val {
  switch (to) {
    case 'number':
      return toNum(v);
    case 'string':
      return toText(v);
    case 'date':
      return toDate(v);
    case 'boolean':
      return toBool(v);
    case 'list':
      return toList(v);
    case 'null':
      return null;
    default:
      return v;
  }
}

const KIND_TO: Record<string, ValueType> = {
  number: 'number',
  text: 'string',
  date: 'date',
  boolean: 'boolean',
  list: 'list',
};

export function evaluateChecked(root: Expr, checked: CheckResult, env: EvalEnv): Val {
  if (checked.issues.length > 0) {
    const first = checked.issues[0]!;
    throw new ExpressionError(first.message, first.pos);
  }
  const fnCtx: JsFnCtx = { now: env.now ?? Date.now(), timeZone: env.timeZone ?? 'UTC' };
  const rows: FeatureVal[] = [env.feature];
  const info = (e: Expr): NodeInfo => {
    const i = checked.info.get(e);
    if (!i) throw new ExpressionError('Internal error: expression was not checked', e.pos);
    return i;
  };
  const truthy = (e: Expr) => toBool(ev(e)) ?? false;

  function side(e: Expr, domain: CompareDomain): Val {
    const v = ev(e);
    switch (domain) {
      case 'number':
        return toNum(v);
      case 'date': {
        const d = toDate(v);
        return d === null ? null : d.ms;
      }
      case 'boolean':
        return toBool(v);
      case 'list':
        return Array.isArray(v) ? v : (() => {
          const t = toText(v);
          return t === null ? null : [t];
        })();
      default:
        return toText(v);
    }
  }

  function equal(a: Val, b: Val): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, k) => x === b[k]);
    }
    return a === b;
  }

  function compare(op: string, l: Expr, r: Expr, domain: CompareDomain): boolean {
    if (domain === 'null') {
      const other = info(l).type === 'null' ? r : l;
      const isNull = info(other).type === 'null' || ev(other) === null;
      return op === '==' ? isNull : !isNull;
    }
    const a = side(l, domain);
    const b = side(r, domain);
    if (op === '!=') {
      if (a === null && b === null) return false;
      if (a === null || b === null) return true;
      return !equal(a, b);
    }
    if (a === null || b === null) return false;
    if (op === '==') return equal(a, b);
    const x = a as number | string | boolean;
    const y = b as number | string | boolean;
    switch (op) {
      case '<':
        return x < y;
      case '<=':
        return x <= y;
      case '>':
        return x > y;
      default:
        return x >= y;
    }
  }

  function branch(e: Expr, to: ValueType): Val {
    return convert(ev(e), to);
  }

  function ev(e: Expr): Val {
    const i = info(e);
    switch (e.kind) {
      case 'num':
        return e.value;
      case 'str':
        return e.value;
      case 'bool':
        return e.value;
      case 'null':
        return null;
      case 'feature':
        return rows[0]!;
      case 'field': {
        const row = e.outer ? rows[0]! : rows[rows.length - 1]!;
        return readField(row.properties[e.name], (i.fieldType ?? 'unknown') as FieldRefType);
      }
      case 'member':
        throw new ExpressionError('Reading a field from another row needs data access', e.pos);
      case 'list':
        return e.items.map((x) => toText(ev(x))).filter((x): x is string => x !== null);
      case 'unop':
        if (e.op === '-') {
          const n = toNum(ev(e.arg));
          return n === null ? null : -n;
        }
        return !truthy(e.arg);
      case 'binop': {
        switch (e.op) {
          case 'AND':
            return truthy(e.left) && truthy(e.right);
          case 'OR':
            return truthy(e.left) || truthy(e.right);
          case '==':
          case '!=':
          case '<':
          case '<=':
          case '>':
          case '>=':
            return compare(e.op, e.left, e.right, i.domain!);
          default:
            break;
        }
        if (i.concat) {
          return (toText(ev(e.left)) ?? '') + (toText(ev(e.right)) ?? '');
        }
        const a = toNum(ev(e.left));
        const b = toNum(ev(e.right));
        if (a === null || b === null) return null;
        let r: number;
        switch (e.op) {
          case '+':
            r = a + b;
            break;
          case '-':
            r = a - b;
            break;
          case '*':
            r = a * b;
            break;
          case '/':
            if (b === 0) return null;
            r = a / b;
            break;
          default:
            if (b === 0) return null;
            r = a - b * Math.trunc(a / b);
        }
        return Number.isFinite(r) ? r : null;
      }
      case 'isnull': {
        const isNull = ev(e.arg) === null;
        return e.negated ? !isNull : isNull;
      }
      case 'in': {
        let hit: boolean;
        if (i.member) {
          const t = toText(ev(e.arg));
          const list = toList(ev(e.list));
          hit = t !== null && list !== null && list.includes(t);
        } else {
          const items = (e.list as Extract<Expr, { kind: 'list' }>).items;
          hit = items.some((item, k) => compare('==', e.arg, item, i.domains![k]!));
        }
        return e.negated ? !hit : hit;
      }
      case 'between': {
        const [d1, d2] = i.domains as [CompareDomain, CompareDomain];
        const hit = compare('>=', e.arg, e.low, d1) && compare('<=', e.arg, e.high, d2);
        return e.negated ? !hit : hit;
      }
      case 'like': {
        const t = toText(ev(e.arg));
        const p = toText(ev(e.pattern));
        const hit = t !== null && p !== null && likeToRegExp(p, e.caseInsensitive).test(t);
        return e.negated ? !hit : hit;
      }
      case 'case': {
        for (let k = 0; k < e.whens.length; k += 1) {
          const w = e.whens[k]!;
          const ok = e.subject ? compare('==', e.subject, w.when, i.domains![k]!) : truthy(w.when);
          if (ok) return branch(w.then, i.type);
        }
        return e.otherwise ? branch(e.otherwise, i.type) : null;
      }
      case 'func':
        return evalFunc(e, i);
    }
  }

  function evalFunc(e: Extract<Expr, { kind: 'func' }>, i: NodeInfo): Val {
    const a = e.args;
    switch (i.variant ? '' : canonicalSpecial(e.name)) {
      case 'if':
        return truthy(a[0]!) ? branch(a[1]!, i.type) : branch(a[2]!, i.type);
      case 'when':
        for (let k = 0; k + 1 < a.length; k += 2) {
          if (truthy(a[k]!)) return branch(a[k + 1]!, i.type);
        }
        return branch(a[a.length - 1]!, i.type);
      case 'decode': {
        let d = 0;
        for (let k = 1; k + 1 < a.length; k += 2) {
          if (compare('==', a[0]!, a[k]!, i.domains![d]!)) return branch(a[k + 1]!, i.type);
          d += 1;
        }
        return branch(a[a.length - 1]!, i.type);
      }
      case 'coalesce':
        for (const x of a) {
          const v = branch(x, i.type);
          if (v !== null) return v;
        }
        return null;
      case 'is_empty': {
        const v = ev(a[0]!);
        return v === null || v === '' || (Array.isArray(v) && v.length === 0);
      }
      default:
        break;
    }
    const v = i.variant!;
    const vals: Val[] = a.map((x, k) => {
      const kind = i.argKinds![k]!;
      if (LITERAL_KINDS.has(kind)) return i.lits![k] as Val;
      const raw = ev(x);
      if (kind === 'any' || kind === 'feature') return raw;
      return convert(raw, KIND_TO[kind]!);
    });
    const out = v.js(vals, fnCtx);
    return typeof out === 'number' && !Number.isFinite(out) ? null : out;
  }

  return ev(root);
}

/** A result as plain JSON: dates become their text form. */
export function toJsonValue(v: Val): unknown {
  if (isDate(v)) return dateText(v);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  return null;
}

/** Convert a result to a requested output type, like the SQL `as`. */
export function convertValue(v: Val, to: ValueType): Val {
  return convert(v, to);
}
