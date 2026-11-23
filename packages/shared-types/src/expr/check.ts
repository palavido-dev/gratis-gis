// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The type checker. It runs before both the SQL compiler and the
 * JavaScript evaluator and records, per node, the decisions both of
 * them must make the same way: the static type, which function variant
 * was chosen, what domain a comparison uses, whether `+` adds or joins
 * text. Neither runtime decides anything about types on its own.
 */

import type { Expr, ExpressionIssue, FieldRef, ValueType } from './ast';
import {
  FUNCTION_INDEX,
  LITERAL_KINDS,
  literalHint,
  normalizeLiteral,
  type ParamKind,
  type Variant,
} from './catalog';
import { lengthUnit } from './geo';
import {
  DATA_ALIASES,
  DATA_FUNCTIONS,
  SET_TO_SET,
  type DataResolver,
  type DataSource,
} from './data';

/** How a comparison reads its two sides. */
export type CompareDomain =
  | 'number'
  | 'text'
  | 'date'
  | 'boolean'
  /** list == list, or list == text meaning "exactly this one value". */
  | 'list'
  /** One side is the null literal: IS NULL / IS NOT NULL. */
  | 'null';

export interface NodeInfo {
  type: ValueType;
  /** Field type for field and member reads. */
  fieldType?: ValueType;
  /** Chosen function variant. */
  variant?: Variant;
  /** Parameter kind each argument is converted to. */
  argKinds?: ParamKind[];
  /** Normalized literal arguments by index. */
  lits?: Record<number, unknown>;
  /** Comparison domain for ==, <, IN items, BETWEEN, decode matches. */
  domain?: CompareDomain;
  /** Per-item domains for IN with a literal list, or decode matches. */
  domains?: CompareDomain[];
  /** `+` joins text instead of adding. */
  concat?: boolean;
  /** IN against a list-valued expression rather than a literal list. */
  member?: boolean;
  /** Row schema of a set or feature value (data access). */
  set?: { fields: FieldRef[]; loose?: boolean; source?: DataSource; limited?: boolean };
  /** Canonical data-access function name when this call is one. */
  data?: string;
}

export interface CheckOptions {
  /** Fields of the feature the expression is evaluated for. */
  fields: FieldRef[];
  /**
   * Accept fields that are not in `fields`, typed unknown. For layers
   * with no declared schema.
   */
  allowUnknownFields?: boolean;
  /** Resolves related tables and other layers. Without it, data access is refused. */
  data?: DataResolver;
}

export interface CheckResult {
  type: ValueType;
  issues: ExpressionIssue[];
  info: Map<Expr, NodeInfo>;
}

const SHOWN: Record<ValueType, string> = {
  number: 'a number',
  string: 'text',
  boolean: 'true/false',
  date: 'a date',
  list: 'a list',
  feature: 'a feature',
  set: 'a set of rows',
  unknown: 'a value of unknown type',
  null: 'null',
};

export const showType = (t: ValueType) => SHOWN[t];

/** Can a value of static type `t` be passed where `kind` is expected? */
export function convertible(t: ValueType, kind: ParamKind): boolean {
  if (t === 'null') return kind !== 'feature';
  switch (kind) {
    case 'number':
      return t === 'number' || t === 'unknown';
    case 'text':
      return t !== 'feature' && t !== 'set';
    case 'date':
      return t === 'date' || t === 'string' || t === 'unknown';
    case 'boolean':
      return t === 'boolean' || t === 'unknown';
    case 'list':
      return t === 'list';
    case 'any':
      return t !== 'feature' && t !== 'set';
    case 'feature':
      return t === 'feature';
    default:
      return false;
  }
}

const KIND_TYPE: Partial<Record<ParamKind, ValueType>> = {
  number: 'number',
  text: 'string',
  date: 'date',
  boolean: 'boolean',
  list: 'list',
};

/** The static type a value has after conversion to `kind`. */
export function typeAfter(kind: ParamKind, from: ValueType): ValueType {
  return KIND_TYPE[kind] ?? from;
}

/** Result type of branches that can each produce a value. */
export function unify(types: ValueType[]): ValueType {
  const real = types.filter((t) => t !== 'null');
  if (real.length === 0) return 'null';
  if (real.every((t) => t === real[0])) return real[0]!;
  const set = new Set(real);
  set.delete('unknown');
  if (set.size === 1) {
    const only = [...set][0]!;
    // unknown is text underneath; it joins text and dates cleanly.
    if (only === 'string' || only === 'date') return only;
  }
  return 'string';
}

function describe(e: Expr): string {
  if (e.kind === 'field') return e.outer ? `$feature.${e.name}` : `{{${e.name}}}`;
  if (e.kind === 'member') return `.${e.name}`;
  if (e.kind === 'str') return `'${e.value}'`;
  if (e.kind === 'num') return String(e.value);
  if (e.kind === 'func') return `${e.name}()`;
  return 'This value';
}

export function compareDomain(
  op: string,
  lt: ValueType,
  rt: ValueType,
  l: Expr,
  r: Expr,
): CompareDomain | { error: string } {
  const equality = op === '==' || op === '!=';
  if (lt === 'null' || rt === 'null') {
    return equality ? 'null' : { error: `Nothing is ${op} null; use IS NULL or IS NOT NULL` };
  }
  if (lt === 'feature' || rt === 'feature' || lt === 'set' || rt === 'set') {
    return { error: `${describe(lt === 'feature' || lt === 'set' ? l : r)} is ${showType(lt === 'feature' || lt === 'set' ? lt : rt)} and cannot be compared; read one of its fields with .name` };
  }
  if (lt === 'list' || rt === 'list') {
    const other = lt === 'list' ? rt : lt;
    if (!equality) {
      return { error: `${op} is not supported for a list; use contains(), any_of() or IN` };
    }
    if (other === 'list' || other === 'string' || other === 'unknown') return 'list';
    return { error: `A list can only be compared with text or another list (got ${showType(other)})` };
  }
  const pair = new Set<ValueType>([lt, rt]);
  const has = (t: ValueType) => pair.has(t);
  const literalText = (t: ValueType, e: Expr) => t === 'string' && e.kind === 'str';
  if (has('number')) {
    const other = lt === 'number' ? rt : lt;
    const otherNode = lt === 'number' ? r : l;
    if (other === 'number' || other === 'unknown' || literalText(other, otherNode)) return 'number';
    return { error: `Cannot compare a number with ${showType(other)}; convert with number() or text() first` };
  }
  if (has('date')) {
    const other = lt === 'date' ? rt : lt;
    if (other === 'date' || other === 'string' || other === 'unknown') return 'date';
    return { error: `Cannot compare a date with ${showType(other)}` };
  }
  if (has('boolean')) {
    const other = lt === 'boolean' ? rt : lt;
    if (other === 'boolean' || other === 'unknown' || (other === 'string' && (l.kind === 'str' || r.kind === 'str'))) {
      return 'boolean';
    }
    return { error: `Cannot compare true/false with ${showType(other)}` };
  }
  return 'text';
}

/** Type and record everything the runtimes need. */
export function checkExpression(root: Expr, opts: CheckOptions): CheckResult {
  const issues: ExpressionIssue[] = [];
  const info = new Map<Expr, NodeInfo>();
  const outerFields = new Map(opts.fields.map((f) => [f.name, f]));
  /** Row scopes: the outer feature first, then set rows inside lambdas. */
  const scopes: Array<{ fields: Map<string, FieldRef>; loose: boolean }> = [
    { fields: outerFields, loose: opts.allowUnknownFields === true },
  ];

  const err = (message: string, pos: number) => issues.push({ message, pos });
  const set = (e: Expr, i: NodeInfo): ValueType => {
    info.set(e, i);
    return i.type;
  };

  function fieldIn(
    scope: { fields: Map<string, FieldRef>; loose: boolean },
    name: string,
    pos: number,
    where: string,
  ): ValueType {
    const f = scope.fields.get(name);
    if (f) return f.type;
    if (scope.loose) return 'unknown';
    const close = [...scope.fields.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    err(
      close
        ? `Field ${where} does not exist; did you mean ${close}? Field names are case-sensitive`
        : `Field ${where} does not exist on this layer`,
      pos,
    );
    return 'unknown';
  }

  function requireBool(e: Expr, t: ValueType, what: string) {
    if (!convertible(t, 'boolean')) {
      err(`${what} needs true or false, but ${describe(e)} is ${showType(t)}`, e.pos);
    }
  }

  function visit(e: Expr): ValueType {
    switch (e.kind) {
      case 'num':
        return set(e, { type: 'number' });
      case 'str':
        return set(e, { type: 'string' });
      case 'bool':
        return set(e, { type: 'boolean' });
      case 'null':
        return set(e, { type: 'null' });
      case 'feature':
        return set(e, { type: 'feature' });
      case 'field': {
        const scope = e.outer ? scopes[0]! : scopes[scopes.length - 1]!;
        const t = fieldIn(scope, e.name, e.pos, e.outer ? `$feature.${e.name}` : `{{${e.name}}}`);
        return set(e, { type: t, fieldType: t });
      }
      case 'member': {
        const ot = visit(e.object);
        const oi = info.get(e.object);
        if (ot !== 'feature' || !oi?.set) {
          err(`Only a feature has fields; ${describe(e.object)} is ${showType(ot)}`, e.pos);
          return set(e, { type: 'unknown' });
        }
        const scope = { fields: new Map(oi.set.fields.map((f) => [f.name, f])), loose: oi.set.loose === true };
        const t = fieldIn(scope, e.name, e.pos, `.${e.name}`);
        return set(e, { type: t, fieldType: t });
      }
      case 'list': {
        const types = e.items.map(visit);
        types.forEach((t, i) => {
          if (!convertible(t, 'text')) err(`A list holds text, not ${showType(t)}`, e.items[i]!.pos);
        });
        return set(e, { type: 'list' });
      }
      case 'unop': {
        const t = visit(e.arg);
        if (e.op === '-') {
          if (!convertible(t, 'number')) {
            err(`${describe(e.arg)} is ${showType(t)} and cannot be negated`, e.arg.pos);
          }
          return set(e, { type: 'number' });
        }
        requireBool(e.arg, t, 'NOT');
        return set(e, { type: 'boolean' });
      }
      case 'binop': {
        const lt = visit(e.left);
        const rt = visit(e.right);
        switch (e.op) {
          case 'AND':
          case 'OR':
            requireBool(e.left, lt, e.op);
            requireBool(e.right, rt, e.op);
            return set(e, { type: 'boolean' });
          case '==':
          case '!=':
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const dom = compareDomain(e.op, lt, rt, e.left, e.right);
            if (typeof dom === 'object') {
              err(dom.error, e.pos);
              return set(e, { type: 'boolean', domain: 'text' });
            }
            return set(e, { type: 'boolean', domain: dom });
          }
          case '~~':
            for (const [t, side] of [[lt, e.left], [rt, e.right]] as const) {
              if (!convertible(t, 'text')) err(`${describe(side)} is ${showType(t)} and cannot be joined as text`, side.pos);
            }
            return set(e, { type: 'string', concat: true });
          case '+':
            if (lt === 'string' || rt === 'string') {
              for (const [t, side] of [[lt, e.left], [rt, e.right]] as const) {
                if (!convertible(t, 'text')) err(`${describe(side)} is ${showType(t)} and cannot be joined as text`, side.pos);
              }
              return set(e, { type: 'string', concat: true });
            }
          // falls through
          default:
            for (const [t, side] of [[lt, e.left], [rt, e.right]] as const) {
              if (convertible(t, 'number')) continue;
              err(
                t === 'date'
                  ? `${describe(side)} is a date; use date_add() or date_diff() for date arithmetic`
                  : t === 'list'
                    ? `${describe(side)} is a list and cannot be used in arithmetic`
                    : `${describe(side)} is ${showType(t)} and cannot be used in arithmetic${t === 'string' ? '; use number() to read text as a number' : ''}`,
                side.pos,
              );
            }
            return set(e, { type: 'number' });
        }
      }
      case 'isnull':
        visit(e.arg);
        return set(e, { type: 'boolean' });
      case 'in': {
        const at = visit(e.arg);
        if (e.list.kind === 'list') {
          const domains: CompareDomain[] = [];
          for (const item of e.list.items) {
            const it = visit(item);
            const dom = compareDomain('==', at, it, e.arg, item);
            if (typeof dom === 'object') {
              err(dom.error, item.pos);
              domains.push('text');
            } else domains.push(dom);
          }
          info.set(e.list, { type: 'list' });
          return set(e, { type: 'boolean', domains });
        }
        const lt = visit(e.list);
        if (lt !== 'list' && lt !== 'null') {
          err(`IN needs a list such as ('a', 'b') or a multi-select field; ${describe(e.list)} is ${showType(lt)}`, e.list.pos);
        }
        if (!convertible(at, 'text')) err(`${describe(e.arg)} is ${showType(at)}`, e.arg.pos);
        return set(e, { type: 'boolean', member: true });
      }
      case 'between': {
        const at = visit(e.arg);
        const lo = visit(e.low);
        const hi = visit(e.high);
        const d1 = compareDomain('>=', at, lo, e.arg, e.low);
        const d2 = compareDomain('<=', at, hi, e.arg, e.high);
        const fix = (x: CompareDomain | { error: string }): CompareDomain => {
          if (typeof x === 'object') {
            err(x.error, e.pos);
            return 'text';
          }
          if (x === 'list' || x === 'null') {
            err('BETWEEN needs numbers, dates or text', e.pos);
            return 'text';
          }
          return x;
        };
        return set(e, { type: 'boolean', domains: [fix(d1), fix(d2)] });
      }
      case 'like': {
        const at = visit(e.arg);
        const pt = visit(e.pattern);
        if (!convertible(at, 'text')) err(`${describe(e.arg)} is ${showType(at)}`, e.arg.pos);
        if (!convertible(pt, 'text')) err(`A LIKE pattern is text`, e.pattern.pos);
        return set(e, { type: 'boolean' });
      }
      case 'case': {
        const st = e.subject ? visit(e.subject) : null;
        const domains: CompareDomain[] = [];
        const results: ValueType[] = [];
        for (const w of e.whens) {
          const wt = visit(w.when);
          if (e.subject) {
            const dom = compareDomain('==', st!, wt, e.subject, w.when);
            if (typeof dom === 'object') {
              err(dom.error, w.when.pos);
              domains.push('text');
            } else domains.push(dom);
          } else requireBool(w.when, wt, 'WHEN');
          results.push(visit(w.then));
        }
        if (e.otherwise) results.push(visit(e.otherwise));
        checkBranches(e, results);
        return set(e, { type: unify(results), domains });
      }
      case 'func':
        return visitFunc(e);
    }
  }

  function checkBranches(e: Expr, types: ValueType[]) {
    const bad = types.find((t) => t === 'feature' || t === 'set');
    if (bad) err(`A result cannot be ${showType(bad)}; read a field from it`, e.pos);
    const real = new Set(types.filter((t) => t !== 'null' && t !== 'unknown'));
    if (real.has('list') && real.size > 1) err('Every result must be a list, or none of them', e.pos);
  }

  function visitFunc(e: Extract<Expr, { kind: 'func' }>): ValueType {
    const name = e.name;
    const dataName = DATA_ALIASES[name] ?? name;
    if (DATA_FUNCTIONS.has(name)) return visitData(e, dataName, null);
    // count, min and max take either plain values or a set of rows.
    let pre: ValueType | null = null;
    if ((name === 'count' || name === 'min' || name === 'max' || name === 'least' || name === 'greatest') && e.args.length > 0) {
      pre = visit(e.args[0]!);
      if (pre === 'set') return visitData(e, name === 'least' ? 'min' : name === 'greatest' ? 'max' : name, pre);
    }
    const spec = FUNCTION_INDEX.get(name);
    if (!spec) {
      e.args.forEach(visit);
      err(`Unknown function ${name}()`, e.pos);
      return set(e, { type: 'unknown' });
    }
    const canonical = spec.name;
    switch (canonical) {
      case 'if': {
        if (e.args.length !== 3) err('if(condition, then, else) takes three values', e.pos);
        const ts = e.args.map(visit);
        if (ts[0] !== undefined) requireBool(e.args[0]!, ts[0], 'if()');
        const results = ts.slice(1, 3);
        checkBranches(e, results);
        return set(e, { type: unify(results) });
      }
      case 'when': {
        if (e.args.length < 3 || e.args.length % 2 === 0) {
          err('when(condition, value, ..., default) takes pairs of condition and value, then a default', e.pos);
        }
        const ts = e.args.map(visit);
        const results: ValueType[] = [];
        ts.forEach((t, i) => {
          const isCond = i % 2 === 0 && i < ts.length - 1;
          if (isCond) requireBool(e.args[i]!, t, 'when()');
          else results.push(t);
        });
        checkBranches(e, results);
        return set(e, { type: unify(results) });
      }
      case 'decode': {
        if (e.args.length < 4 || e.args.length % 2 !== 0) {
          err('decode(value, match, result, ..., default) takes the value, pairs of match and result, then a default', e.pos);
        }
        const ts = e.args.map(visit);
        const domains: CompareDomain[] = [];
        const results: ValueType[] = [];
        for (let i = 1; i < ts.length; i += 1) {
          const isMatch = i % 2 === 1 && i < ts.length - 1;
          if (isMatch) {
            const dom = compareDomain('==', ts[0]!, ts[i]!, e.args[0]!, e.args[i]!);
            if (typeof dom === 'object') {
              err(dom.error, e.args[i]!.pos);
              domains.push('text');
            } else domains.push(dom);
          } else results.push(ts[i]!);
        }
        checkBranches(e, results);
        return set(e, { type: unify(results), domains });
      }
      case 'coalesce': {
        if (e.args.length < 2) err('coalesce() takes at least two values', e.pos);
        const ts = e.args.map(visit);
        checkBranches(e, ts);
        return set(e, { type: unify(ts) });
      }
      case 'is_empty': {
        if (e.args.length !== 1) err('is_empty() takes one value', e.pos);
        e.args.forEach(visit);
        return set(e, { type: 'boolean' });
      }
      default:
        break;
    }

    const types = e.args.map((a, i) => (i === 0 && pre !== null ? pre : visit(a)));
    const arityOk = (v: Variant) => {
      const max = v.rest ? Infinity : v.params.length;
      const min = v.params.length - (v.optional ?? 0);
      return types.length >= min && types.length <= max;
    };
    const candidates = spec.variants.filter((v) => !v.match || v.match(types));
    const variant = candidates.find(arityOk) ?? candidates[0] ?? spec.variants[0]!;
    if (!arityOk(variant)) {
      err(`${variant.signature} ${describeArity(variant)}, not ${types.length}`, e.pos);
    }
    const argKinds: ParamKind[] = [];
    const lits: Record<number, unknown> = {};
    types.forEach((t, i) => {
      const kind = variant.params[i] ?? variant.rest ?? 'any';
      argKinds.push(kind);
      const arg = e.args[i]!;
      if (LITERAL_KINDS.has(kind)) {
        const lit = arg.kind === 'str' ? normalizeLiteral(kind, arg.value) : null;
        if (lit === null) err(`${spec.name}() needs ${literalHint(kind)} here`, arg.pos);
        else lits[i] = lit;
        return;
      }
      if (!convertible(t, kind)) {
        err(
          kind === 'feature'
            ? `${spec.name}() needs $feature here`
            : `${spec.name}() needs ${showType(KIND_TYPE[kind] ?? 'unknown')} here, but ${describe(arg)} is ${showType(t)}${kind === 'number' && t === 'string' ? '; use number() to read text as a number' : ''}`,
          arg.pos,
        );
      }
    });
    const ret = typeof variant.returns === 'function' ? variant.returns(types) : variant.returns;
    return set(e, { type: ret, variant, argKinds, lits });
  }

  /** The row schema of a set or feature argument, or null after an error. */
  function setArg(e: Expr, fn: string, t?: ValueType): NonNullable<NodeInfo['set']> | null {
    const ty = t ?? visit(e);
    const si = info.get(e)?.set;
    if (ty !== 'set' || !si) {
      if (ty !== 'unknown') {
        err(`${fn}() needs rows here, such as related('table') or layer('name'); ${describe(e)} is ${showType(ty)}`, e.pos);
      }
      return null;
    }
    return si;
  }

  /** Visit `e` with the rows of `rows` as {{field}}. */
  function inRows<T>(rows: NonNullable<NodeInfo['set']> | null, f: () => T): T {
    scopes.push({
      fields: new Map((rows?.fields ?? []).map((x) => [x.name, x])),
      loose: rows === null || rows.loose === true,
    });
    try {
      return f();
    } finally {
      scopes.pop();
    }
  }

  function literalText(e: Expr | undefined, fn: string, what: string): string | null {
    if (!e || e.kind !== 'str') {
      err(`${fn}() needs ${what} in quotes here`, e?.pos ?? 0);
      if (e) visit(e);
      return null;
    }
    info.set(e, { type: 'string' });
    return e.value;
  }

  function arity(e: Extract<Expr, { kind: 'func' }>, fn: string, min: number, max: number, sig: string) {
    if (e.args.length < min || e.args.length > max) err(`${sig} takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? '' : 's'}`, e.pos);
  }

  function visitData(e: Extract<Expr, { kind: 'func' }>, fn: string, firstType: ValueType | null): ValueType {
    const resolver = opts.data;
    const a = e.args;
    const lits: Record<number, unknown> = {};
    const done = (type: ValueType, extra: Partial<NodeInfo> = {}) =>
      set(e, { type, data: fn, lits, ...extra });
    const first = () => setArg(a[0]!, fn, firstType ?? undefined);

    if (fn === 'related' || fn === 'layer') {
      arity(e, fn, 1, fn === 'layer' ? 2 : 1, fn === 'layer' ? "layer('name', 'sublayer')" : "related('table')");
      const name = literalText(a[0], fn, fn === 'related' ? 'the related table name' : 'the layer name');
      const sub = fn === 'layer' && a[1] ? literalText(a[1], fn, 'the sublayer name') : undefined;
      if (name === null) return done('set', { set: { fields: [], loose: true } });
      if (!resolver) {
        err(`${fn}() is not available here: this expression cannot read other rows`, e.pos);
        return done('set', { set: { fields: [], loose: true } });
      }
      const r = fn === 'related' ? resolver.related(name) : resolver.layer(name, sub ?? undefined);
      if ('error' in r) {
        err(r.error, a[0]!.pos);
        return done('set', { set: { fields: [], loose: true } });
      }
      return done('set', { set: { fields: r.fields, source: r } });
    }
    if (a.length === 0) {
      err(`${fn}() needs rows as its first value`, e.pos);
      return done('unknown');
    }
    const rows = first();
    if (rows?.limited && ['filter', 'order_by', 'within_distance', 'intersecting', 'containing', 'within', 'nearest', 'distance_to'].includes(fn)) {
      err(`Use ${fn}() before top(): top() keeps the first rows, so nothing can narrow them afterwards`, e.pos);
    }
    const spatial = () => {
      if (rows?.source && !rows.source.hasGeometry) {
        err(`${rows.source.label} has no geometry, so ${fn}() cannot use it`, a[0]!.pos);
      }
    };
    switch (fn) {
      case 'filter': {
        arity(e, fn, 2, 2, 'filter(rows, condition)');
        if (a[1]) inRows(rows, () => requireBool(a[1]!, visit(a[1]!), 'filter()'));
        return done('set', { set: rows ?? { fields: [], loose: true } });
      }
      case 'order_by': {
        arity(e, fn, 2, 3, "order_by(rows, value, 'desc')");
        if (a[1]) {
          const t = inRows(rows, () => visit(a[1]!));
          if (t === 'list' || t === 'set' || t === 'feature') err(`Rows cannot be sorted by ${showType(t)}`, a[1].pos);
        }
        if (a[2]) {
          const dir = literalText(a[2], fn, "'asc' or 'desc'");
          if (dir !== null && dir.toLowerCase() !== 'asc' && dir.toLowerCase() !== 'desc') {
            err("order_by() sorts 'asc' or 'desc'", a[2].pos);
          }
          lits[2] = (dir ?? 'asc').toLowerCase();
        } else lits[2] = 'asc';
        return done('set', { set: rows ?? { fields: [], loose: true } });
      }
      case 'top': {
        arity(e, fn, 2, 2, 'top(rows, n)');
        if (a[1]) {
          if (a[1].kind !== 'num' || a[1].value < 0 || !Number.isInteger(a[1].value)) {
            err('top() needs a whole number such as 5', a[1].pos);
          } else lits[1] = a[1].value;
          visit(a[1]);
        }
        return done('set', { set: { ...(rows ?? { fields: [], loose: true }), limited: true } });
      }
      case 'within_distance': {
        arity(e, fn, 3, 3, "within_distance(rows, distance, 'unit')");
        spatial();
        if (a[1]) {
          const t = visit(a[1]);
          if (!convertible(t, 'number')) err('within_distance() needs a number for the distance', a[1].pos);
        }
        if (a[2]) {
          const u = literalText(a[2], fn, literalHint('length-unit'));
          const unit = u === null ? null : lengthUnit(u);
          if (u !== null && unit === null) err(`within_distance() needs ${literalHint('length-unit')}`, a[2].pos);
          lits[2] = unit ?? 'meters';
        }
        return done('set', { set: rows ?? { fields: [], loose: true } });
      }
      case 'intersecting':
      case 'containing':
      case 'within':
        arity(e, fn, 1, 1, `${fn}(rows)`);
        spatial();
        return done('set', { set: rows ?? { fields: [], loose: true } });
      case 'first':
      case 'last':
        arity(e, fn, 1, 1, `${fn}(rows)`);
        return done('feature', { set: rows ?? { fields: [], loose: true } });
      case 'nearest': {
        arity(e, fn, 1, 3, "nearest(rows, max distance, 'unit')");
        spatial();
        if (a[1]) {
          const t = visit(a[1]);
          if (!convertible(t, 'number')) err('nearest() needs a number for the maximum distance', a[1].pos);
        }
        lits[2] = 'meters';
        if (a[2]) {
          const u = literalText(a[2], fn, literalHint('length-unit'));
          const unit = u === null ? null : lengthUnit(u);
          if (u !== null && unit === null) err(`nearest() needs ${literalHint('length-unit')}`, a[2].pos);
          lits[2] = unit ?? 'meters';
        }
        return done('feature', { set: rows ?? { fields: [], loose: true } });
      }
      case 'distance_to': {
        arity(e, fn, 1, 2, "distance_to(rows, 'unit')");
        spatial();
        lits[1] = 'meters';
        if (a[1]) {
          const u = literalText(a[1], fn, literalHint('length-unit'));
          const unit = u === null ? null : lengthUnit(u);
          if (u !== null && unit === null) err(`distance_to() needs ${literalHint('length-unit')}`, a[1].pos);
          lits[1] = unit ?? 'meters';
        }
        return done('number');
      }
      case 'count':
        arity(e, fn, 1, 1, 'count(rows)');
        return done('number');
      case 'exists':
        arity(e, fn, 1, 1, 'exists(rows)');
        return done('boolean');
      case 'sum':
      case 'avg':
      case 'min':
      case 'max':
      case 'count_distinct':
      case 'list': {
        const sig = fn === 'list' ? "list(rows, value, ', ')" : `${fn}(rows, value)`;
        arity(e, fn, 2, fn === 'list' ? 3 : 2, sig);
        let t: ValueType = 'unknown';
        if (a[1]) t = inRows(rows, () => visit(a[1]!));
        if (fn === 'sum' || fn === 'avg') {
          if (a[1] && !convertible(t, 'number')) err(`${fn}() adds up numbers; ${describe(a[1])} is ${showType(t)}`, a[1].pos);
          return done('number', { domain: 'number' });
        }
        if (fn === 'count_distinct') {
          if (a[1] && !convertible(t, 'text')) err(`${describe(a[1])} is ${showType(t)}`, a[1].pos);
          return done('number', { domain: 'text' });
        }
        if (fn === 'list') {
          if (a[1] && !convertible(t, 'text')) err(`${describe(a[1])} is ${showType(t)}`, a[1].pos);
          if (a[2] && !convertible(visit(a[2]), 'text')) err('The separator is text', a[2].pos);
          return done('string', { domain: 'text' });
        }
        // min and max keep the value's type: the latest date, say.
        const dom: CompareDomain = t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'boolean' ? 'boolean' : 'text';
        if (t === 'list' || t === 'set' || t === 'feature') err(`${fn}() cannot compare ${showType(t)}`, a[1]!.pos);
        return done(dom === 'text' ? 'string' : (dom as ValueType), { domain: dom });
      }
      case 'lookup': {
        arity(e, fn, 4, 4, "lookup(rows, 'key field', value, 'result field')");
        const key = literalText(a[1], fn, 'the key field name');
        if (a[2]) {
          const vt = visit(a[2]);
          if (!convertible(vt, 'text')) err(`${describe(a[2])} is ${showType(vt)}`, a[2].pos);
        }
        const ret = literalText(a[3], fn, 'the result field name');
        const fields = new Map((rows?.fields ?? []).map((f) => [f.name, f]));
        const loose = rows === null || rows.loose === true;
        if (key !== null && !fields.has(key) && !loose) err(`${rows?.source?.label ?? 'These rows'} have no field ${key}`, a[1]!.pos);
        let t: ValueType = 'unknown';
        if (ret !== null) {
          const f = fields.get(ret);
          if (f) t = f.type;
          else if (!loose) err(`${rows?.source?.label ?? 'These rows'} have no field ${ret}`, a[3]!.pos);
        }
        lits[1] = key;
        lits[3] = ret;
        return done(t, { fieldType: t, set: rows ?? { fields: [], loose: true } });
      }
      default:
        err(`Unknown function ${fn}()`, e.pos);
        return done('unknown');
    }
  }

  const type = visit(root);
  if (type === 'set' || type === 'feature') {
    issues.push({
      message:
        type === 'set'
          ? 'The result is a set of rows; summarize it with count(), max() or similar, or read one row with first(...).field'
          : 'The result is a whole feature; read one of its fields with .name',
      pos: root.pos,
    });
  }
  return { type, issues, info };
}

function describeArity(v: Variant): string {
  const min = v.params.length - (v.optional ?? 0);
  if (v.rest) return `takes at least ${min} value${min === 1 ? '' : 's'}`;
  if (min === v.params.length) return `takes ${min} value${min === 1 ? '' : 's'}`;
  return `takes ${min} to ${v.params.length} values`;
}
