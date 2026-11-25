// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * The `where` clause of an Esri FeatureServer query, parsed into a
 * tree. The grammar is closed: comparisons, AND, OR, NOT, parentheses,
 * IN, BETWEEN, LIKE, IS [NOT] NULL, UPPER() and LOWER() on a field,
 * and string, number, DATE and TIMESTAMP literals. That covers what
 * ArcGIS Pro and QGIS send (definition queries, selections, searches).
 * Anything else is refused with a 400 that says what is not supported.
 * Nothing here reaches SQL as text: esri-sql.ts compiles the tree with
 * every value bound as a parameter.
 */

export type WhereLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: string };

export type WhereField = { name: string; fn?: 'upper' | 'lower' };

export type CmpOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export type WhereNode =
  | { t: 'const'; value: boolean }
  | { t: 'and'; items: WhereNode[] }
  | { t: 'or'; items: WhereNode[] }
  | { t: 'not'; item: WhereNode }
  | { t: 'cmp'; op: CmpOp; field: WhereField; value: WhereLiteral }
  | { t: 'in'; field: WhereField; values: WhereLiteral[]; negated: boolean }
  | { t: 'null'; field: WhereField; negated: boolean }
  | { t: 'like'; field: WhereField; pattern: string; escape?: string; negated: boolean }
  | { t: 'between'; field: WhereField; lo: WhereLiteral; hi: WhereLiteral; negated: boolean };

/** Longest where clause accepted. Pro's biggest are ObjectID lists. */
export const MAX_WHERE_LENGTH = 200_000;
/** Most literals in one where clause, so the SQL stays under Postgres's parameter limit. */
export const MAX_WHERE_VALUES = 20_000;
const MAX_DEPTH = 40;

type Tok =
  | { k: 'id'; v: string; quoted: boolean }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'op'; v: string }
  | { k: 'punc'; v: '(' | ')' | ',' };

const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ESCAPE', 'BETWEEN',
  'DATE', 'TIMESTAMP', 'UPPER', 'LOWER', 'TRUE', 'FALSE',
]);

function bad(message: string): BadRequestException {
  return new BadRequestException(`Invalid where clause: ${message}`);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw bad('a string is missing its closing quote.');
        const ch = src[i]!;
        if (ch === "'") {
          if (src[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += ch;
        i++;
      }
      out.push({ k: 'str', v });
      continue;
    }
    if (c === '"' || c === '[') {
      const close = c === '"' ? '"' : ']';
      const end = src.indexOf(close, i + 1);
      if (end < 0) throw bad('a quoted field name is missing its closing quote.');
      const v = src.slice(i + 1, end);
      if (v.length === 0) throw bad('a quoted field name is empty.');
      out.push({ k: 'id', v, quoted: true });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw bad(`unexpected "${c}".`);
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], quoted: false });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '!=' || two === '<=' || two === '>=') {
      out.push({ k: 'op', v: two === '!=' ? '<>' : two });
      i += 2;
      continue;
    }
    if (c === '=' || c === '<' || c === '>' || c === '-' || c === '+') {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ k: 'punc', v: c });
      i++;
      continue;
    }
    throw bad(`unexpected "${c}".`);
  }
  return out;
}

const isKw = (t: Tok | undefined, kw: string): boolean =>
  t?.k === 'id' && !t.quoted && t.v.toUpperCase() === kw;

class Parser {
  private pos = 0;
  values = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): WhereNode {
    if (this.toks.length === 0) return { t: 'const', value: true };
    const node = this.or(0);
    if (this.pos < this.toks.length) throw bad(`unexpected text near "${this.show(this.peek())}".`);
    return node;
  }

  private peek(o = 0): Tok | undefined {
    return this.toks[this.pos + o];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }
  private show(t: Tok | undefined): string {
    if (!t) return 'the end';
    if (t.k === 'str') return `'${t.v}'`;
    return String(t.v);
  }
  private expectPunc(p: '(' | ')' | ','): void {
    const t = this.next();
    if (t?.k !== 'punc' || t.v !== p) throw bad(`expected "${p}" near "${this.show(t)}".`);
  }
  private expectKw(kw: string): void {
    if (!isKw(this.next(), kw)) throw bad(`expected ${kw}.`);
  }

  private or(depth: number): WhereNode {
    if (depth > MAX_DEPTH) throw bad('it is nested too deeply.');
    const items = [this.and(depth)];
    while (isKw(this.peek(), 'OR')) {
      this.pos++;
      items.push(this.and(depth));
    }
    return items.length === 1 ? items[0]! : { t: 'or', items };
  }

  private and(depth: number): WhereNode {
    const items = [this.not(depth)];
    while (isKw(this.peek(), 'AND')) {
      this.pos++;
      items.push(this.not(depth));
    }
    return items.length === 1 ? items[0]! : { t: 'and', items };
  }

  private not(depth: number): WhereNode {
    if (isKw(this.peek(), 'NOT')) {
      this.pos++;
      return { t: 'not', item: this.not(depth + 1) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): WhereNode {
    const t = this.peek();
    if (t?.k === 'punc' && t.v === '(') {
      // A parenthesis opens either a group or nothing else: there are
      // no subqueries and no parenthesised operands.
      this.pos++;
      const inner = this.or(depth + 1);
      this.expectPunc(')');
      return inner;
    }
    if (isKw(t, 'TRUE')) {
      this.pos++;
      return { t: 'const', value: true };
    }
    if (isKw(t, 'FALSE')) {
      this.pos++;
      return { t: 'const', value: false };
    }
    return this.predicate();
  }

  /** A field reference, or null when the next token is a literal. */
  private fieldRef(): WhereField | null {
    const t = this.peek();
    if (t?.k !== 'id') return null;
    const kw = t.quoted ? null : t.v.toUpperCase();
    if (kw === 'UPPER' || kw === 'LOWER') {
      this.pos++;
      this.expectPunc('(');
      const inner = this.next();
      if (inner?.k !== 'id' || (!inner.quoted && KEYWORDS.has(inner.v.toUpperCase()))) {
        throw bad(`${kw}() takes a field name.`);
      }
      this.expectPunc(')');
      return { name: inner.v, fn: kw === 'UPPER' ? 'upper' : 'lower' };
    }
    if (kw === 'DATE' || kw === 'TIMESTAMP' || kw === 'NULL') return null;
    if (kw !== null && KEYWORDS.has(kw)) throw bad(`unexpected ${t.v}.`);
    this.pos++;
    return { name: t.v };
  }

  private literal(): WhereLiteral {
    const t = this.next();
    if (t?.k === 'str') return this.count({ kind: 'string', value: t.v });
    if (t?.k === 'num') return this.count({ kind: 'number', value: t.v });
    if (t?.k === 'op' && (t.v === '-' || t.v === '+')) {
      const n = this.next();
      if (n?.k !== 'num') throw bad(`expected a number after "${t.v}".`);
      return this.count({ kind: 'number', value: t.v === '-' ? -n.v : n.v });
    }
    if (isKw(t, 'DATE') || isKw(t, 'TIMESTAMP')) {
      const s = this.next();
      if (s?.k !== 'str') throw bad(`${String(t!.v).toUpperCase()} takes a quoted value.`);
      return this.count({ kind: 'date', value: s.v });
    }
    throw bad(`expected a value near "${this.show(t)}".`);
  }

  private count(l: WhereLiteral): WhereLiteral {
    this.values++;
    if (this.values > MAX_WHERE_VALUES) {
      throw bad(`it has more than ${MAX_WHERE_VALUES} values.`);
    }
    return l;
  }

  private predicate(): WhereNode {
    const field = this.fieldRef();
    if (!field) {
      // literal op literal (1=1, 1=0), or literal op field.
      const left = this.literal();
      const op = this.next();
      if (op?.k !== 'op' || op.v === '-' || op.v === '+') throw bad('expected a comparison.');
      const rightField = this.fieldRef();
      if (rightField) {
        return { t: 'cmp', op: flip(op.v as CmpOp), field: rightField, value: left };
      }
      const right = this.literal();
      return { t: 'const', value: compareLiterals(left, op.v as CmpOp, right) };
    }
    let negated = false;
    if (isKw(this.peek(), 'NOT')) {
      negated = true;
      this.pos++;
    }
    const t = this.peek();
    if (isKw(t, 'IN')) {
      this.pos++;
      this.expectPunc('(');
      const values = [this.literal()];
      while (this.peek()?.k === 'punc' && (this.peek() as { v: string }).v === ',') {
        this.pos++;
        values.push(this.literal());
      }
      this.expectPunc(')');
      return { t: 'in', field, values, negated };
    }
    if (isKw(t, 'LIKE')) {
      this.pos++;
      const p = this.next();
      if (p?.k !== 'str') throw bad('LIKE takes a quoted pattern.');
      let escape: string | undefined;
      if (isKw(this.peek(), 'ESCAPE')) {
        this.pos++;
        const e = this.next();
        if (e?.k !== 'str' || e.v.length !== 1) throw bad('ESCAPE takes one quoted character.');
        escape = e.v;
      }
      this.count({ kind: 'string', value: p.v });
      return { t: 'like', field, pattern: p.v, negated, ...(escape ? { escape } : {}) };
    }
    if (isKw(t, 'BETWEEN')) {
      this.pos++;
      const lo = this.literal();
      this.expectKw('AND');
      const hi = this.literal();
      return { t: 'between', field, lo, hi, negated };
    }
    if (negated) throw bad('NOT after a field must be followed by IN, LIKE or BETWEEN.');
    if (isKw(t, 'IS')) {
      this.pos++;
      let isNot = false;
      if (isKw(this.peek(), 'NOT')) {
        isNot = true;
        this.pos++;
      }
      this.expectKw('NULL');
      return { t: 'null', field, negated: isNot };
    }
    const op = this.next();
    if (op?.k !== 'op' || op.v === '-' || op.v === '+') {
      throw bad(`expected a comparison after ${field.name}.`);
    }
    if (this.fieldRef()) throw bad('comparing two fields is not supported.');
    if (isKw(this.peek(), 'NULL')) throw bad(`use "${field.name} IS NULL" to test for no value.`);
    return { t: 'cmp', op: op.v as CmpOp, field, value: this.literal() };
  }
}

function flip(op: CmpOp): CmpOp {
  switch (op) {
    case '<':
      return '>';
    case '>':
      return '<';
    case '<=':
      return '>=';
    case '>=':
      return '<=';
    default:
      return op;
  }
}

/** `1=1`, `1=0`, `'a'='a'`: decided here, never sent to SQL. */
function compareLiterals(a: WhereLiteral, op: CmpOp, b: WhereLiteral): boolean {
  if (a.kind !== b.kind) throw bad('compares two values of different kinds.');
  let cmp: number;
  if (a.kind === 'number') {
    cmp = Math.sign(a.value - (b.value as number));
  } else {
    const x = a.value;
    const y = b.value as string;
    cmp = x === y ? 0 : x < y ? -1 : 1;
  }
  switch (op) {
    case '=':
      return cmp === 0;
    case '<>':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
  }
}

/** Parse a where clause. Empty or missing means every feature. */
export function parseEsriWhere(raw: string | undefined): WhereNode {
  const src = (raw ?? '').trim();
  if (src.length > MAX_WHERE_LENGTH) {
    throw bad(`it is longer than ${MAX_WHERE_LENGTH} characters.`);
  }
  return new Parser(tokenize(src)).parse();
}
