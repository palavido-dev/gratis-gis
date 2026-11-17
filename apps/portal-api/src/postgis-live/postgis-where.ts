// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Compile a PostGIS Live `whereClause` into parameterized SQL.
 *
 * Saved maps store this string and send it on every bbox read, so
 * deleting the field would blank those layers. The grammar below is
 * the subset those layers actually need: comparisons, IS NULL,
 * IN lists, LIKE / ILIKE, AND / OR / NOT, and parentheses. Column
 * names have to be on the layer. Values are bound as parameters.
 * Anything else (a function call, a subquery, a second statement)
 * is refused, and the layer author is told to use the structured
 * filter instead.
 */
import { BadRequestException } from '@nestjs/common';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

type Token =
  | { kind: 'ident'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'kw'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'lp' }
  | { kind: 'rp' }
  | { kind: 'comma' };

export function compileSafeWhere(
  raw: string,
  allowed: Set<string>,
  paramOffset: number,
): { sql: string; params: unknown[] } {
  const tokens = tokenize(raw);
  const params: unknown[] = [];
  const parser = new Parser(tokens, allowed, paramOffset, params);
  const sql = parser.parseOr();
  parser.expectEnd();
  return { sql, params };
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly allowed: Set<string>,
    private readonly paramOffset: number,
    private readonly params: unknown[],
  ) {}

  parseOr(): string {
    let left = this.parseAnd();
    while (this.peekKw('or')) {
      this.index += 1;
      left = `(${left} OR ${this.parseAnd()})`;
    }
    return left;
  }

  parseAnd(): string {
    let left = this.parseNot();
    while (this.peekKw('and')) {
      this.index += 1;
      left = `(${left} AND ${this.parseNot()})`;
    }
    return left;
  }

  parseNot(): string {
    if (this.peekKw('not')) {
      this.index += 1;
      return `(NOT ${this.parseNot()})`;
    }
    return this.parsePrimary();
  }

  parsePrimary(): string {
    if (this.peek()?.kind === 'lp') {
      this.index += 1;
      const inner = this.parseOr();
      this.expectKind('rp');
      return `(${inner})`;
    }
    return this.parsePredicate();
  }

  parsePredicate(): string {
    const column = this.expectIdent();
    if (this.peekKw('is')) {
      this.index += 1;
      const negated = this.peekKw('not');
      if (negated) this.index += 1;
      if (!this.peekKw('null')) this.fail();
      this.index += 1;
      return `${column} IS ${negated ? 'NOT ' : ''}NULL`;
    }
    if (this.peekKw('not')) {
      this.index += 1;
      if (!(this.peekKw('like') || this.peekKw('ilike') || this.peekKw('in'))) {
        this.fail();
      }
      return this.parseMatch(column, true);
    }
    if (this.peekKw('like') || this.peekKw('ilike') || this.peekKw('in')) {
      return this.parseMatch(column, false);
    }
    const op = this.peek();
    if (!op || op.kind !== 'op') this.fail();
    this.index += 1;
    const value = this.parseValue();
    return `${column} ${op.text} ${value}`;
  }

  parseMatch(column: string, negated: boolean): string {
    if (this.peekKw('in')) {
      this.index += 1;
      this.expectKind('lp');
      const values: string[] = [];
      values.push(this.parseValue());
      while (this.peek()?.kind === 'comma') {
        this.index += 1;
        values.push(this.parseValue());
      }
      this.expectKind('rp');
      const not = negated ? 'NOT ' : '';
      return `${column} ${not}IN (${values.join(', ')})`;
    }
    const kw = this.peek();
    if (!kw || kw.kind !== 'kw' || (kw.text !== 'like' && kw.text !== 'ilike')) {
      this.fail();
    }
    this.index += 1;
    const value = this.parseValue();
    const not = negated ? 'NOT ' : '';
    const op = kw.text === 'ilike' ? 'ILIKE' : 'LIKE';
    return `${column} ${not}${op} ${value}`;
  }

  parseValue(): string {
    const token = this.peek();
    if (!token) this.fail();
    if (token.kind === 'string') {
      this.index += 1;
      this.params.push(token.text);
      return `$${this.paramOffset + this.params.length}`;
    }
    if (token.kind === 'number') {
      this.index += 1;
      const n = Number(token.text);
      if (!Number.isFinite(n)) this.fail();
      this.params.push(n);
      return `$${this.paramOffset + this.params.length}`;
    }
    if (token.kind === 'kw' && (token.text === 'true' || token.text === 'false')) {
      this.index += 1;
      this.params.push(token.text === 'true');
      return `$${this.paramOffset + this.params.length}`;
    }
    if (token.kind === 'ident') {
      this.index += 1;
      if (!IDENT.test(token.text) || !this.allowed.has(token.text)) {
        throw new BadRequestException(
          `Filter field "${token.text}" is not a known column on this layer`,
        );
      }
      return quoteIdent(token.text);
    }
    this.fail();
  }

  expectIdent(): string {
    const token = this.peek();
    if (!token || token.kind !== 'ident' || !IDENT.test(token.text)) this.fail();
    if (!this.allowed.has(token.text)) {
      throw new BadRequestException(
        `Filter field "${token.text}" is not a known column on this layer`,
      );
    }
    this.index += 1;
    return quoteIdent(token.text);
  }

  expectKind(kind: Token['kind']): void {
    const token = this.peek();
    if (!token || token.kind !== kind) this.fail();
    this.index += 1;
  }

  expectEnd(): void {
    if (this.index !== this.tokens.length) this.fail();
  }

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  peekKw(text: string): boolean {
    const token = this.peek();
    return token?.kind === 'kw' && token.text === text;
  }

  fail(): never {
    throw new BadRequestException(
      'This filter uses a form the portal cannot check. Use the structured filter, or a comparison, IS NULL, IN, LIKE, AND, OR, and parentheses.',
    );
  }
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lp' });
      i += 1;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rp' });
      i += 1;
      continue;
    }
    if (c === ',') {
      tokens.push({ kind: 'comma' });
      i += 1;
      continue;
    }
    if (c === "'") {
      let text = '';
      i += 1;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === "'" && raw[i + 1] === "'") {
          text += "'";
          i += 2;
          continue;
        }
        if (raw[i] === "'") {
          i += 1;
          closed = true;
          break;
        }
        text += raw[i];
        i += 1;
      }
      if (!closed) throw refused();
      tokens.push({ kind: 'string', text });
      continue;
    }
    const op = readOp(raw, i);
    if (op) {
      tokens.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      i += 1;
      while (i < raw.length && /[A-Za-z0-9_]/.test(raw[i] as string)) i += 1;
      const word = raw.slice(start, i);
      const lower = word.toLowerCase();
      if (
        lower === 'and' ||
        lower === 'or' ||
        lower === 'not' ||
        lower === 'is' ||
        lower === 'null' ||
        lower === 'in' ||
        lower === 'like' ||
        lower === 'ilike' ||
        lower === 'true' ||
        lower === 'false'
      ) {
        tokens.push({ kind: 'kw', text: lower });
      } else {
        tokens.push({ kind: 'ident', text: word });
      }
      continue;
    }
    if (c === '-' || c === '+' || /[0-9]/.test(c)) {
      const start = i;
      if (c === '-' || c === '+') i += 1;
      let digits = false;
      while (i < raw.length && /[0-9]/.test(raw[i] as string)) {
        digits = true;
        i += 1;
      }
      if (raw[i] === '.') {
        i += 1;
        while (i < raw.length && /[0-9]/.test(raw[i] as string)) {
          digits = true;
          i += 1;
        }
      }
      if (!digits) throw refused();
      tokens.push({ kind: 'number', text: raw.slice(start, i) });
      continue;
    }
    throw refused();
  }
  return tokens;
}

function readOp(raw: string, i: number): string | null {
  const two = raw.slice(i, i + 2);
  if (two === '<>' || two === '!=' || two === '<=' || two === '>=') return two;
  const one = raw[i];
  if (one === '=' || one === '<' || one === '>') return one;
  return null;
}

function refused(): BadRequestException {
  return new BadRequestException(
    'This filter uses a form the portal cannot check. Use the structured filter, or a comparison, IS NULL, IN, LIKE, AND, OR, and parentheses.',
  );
}
