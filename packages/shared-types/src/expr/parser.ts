// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tokenizer and recursive-descent parser.
 *
 * Grammar, loosest binding first:
 *
 *   expr     := or
 *   or       := and ( ('OR' | '||') and )*
 *   and      := not ( ('AND' | '&&') not )*
 *   not      := ('NOT' | '!') not | compare
 *   compare  := concat [ cmpop concat
 *                      | 'IS' ['NOT'] 'NULL'
 *                      | ['NOT'] 'IN' (list | concat)
 *                      | ['NOT'] 'BETWEEN' concat 'AND' concat
 *                      | ['NOT'] ('LIKE' | 'ILIKE') concat ]
 *   cmpop    := '==' | '=' | '!=' | '<>' | '<' | '<=' | '>' | '>='
 *   concat   := add ( '~~' add )*
 *   add      := mul ( ('+' | '-') mul )*
 *   mul      := unary ( ('*' | '/' | '%') unary )*
 *   unary    := '-' unary | postfix
 *   postfix  := primary ( '.' IDENT | '[' string ']' )*
 *   primary  := number | string | 'true' | 'false' | 'null'
 *             | '{{' name '}}' | '$feature'
 *             | IDENT '(' [ expr (',' expr)* ] ')'
 *             | '[' [ expr (',' expr)* ] ']'
 *             | 'CASE' [expr] ('WHEN' expr 'THEN' expr)+ ['ELSE' expr] 'END'
 *             | '(' expr ')'
 *
 * Keywords are case-insensitive. Strings take single or double
 * quotes with backslash escapes. `//` starts a comment.
 *
 * Arcade spellings are accepted where they do not clash: `&&`, `||`,
 * `!`, `$feature.name`, `$feature["name"]`, and Arcade function names
 * through the function catalog's aliases. `+` joins text when either
 * side is text, as in Arcade; the checker decides that, not the
 * parser.
 */

import {
  ExpressionError,
  type BinOp,
  type Expr,
} from './ast';
import {
  isSqlSafeFieldName,
  MAX_SQL_SAFE_FIELD_NAME_LENGTH,
  SQL_SAFE_FIELD_NAME_RE,
} from './names';

type TokenKind =
  | 'num'
  | 'str'
  | 'ident'
  | 'field'
  | 'dollar'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'op'
  | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  pos: number;
}

/** Words the tokenizer turns into operators or keywords. */
const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'BETWEEN',
  'LIKE',
  'ILIKE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'TRUE',
  'FALSE',
  'NULL',
]);

/** Upper bound on source length; a guard, not a style rule. */
export const MAX_EXPRESSION_LENGTH = 20_000;
/** Nesting depth guard so a crafted input cannot overflow the stack. */
const MAX_DEPTH = 200;

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function checkFieldName(name: string, pos: number): void {
  if (name.length === 0) {
    throw new ExpressionError('Empty field reference {{}}', pos);
  }
  if (!isSqlSafeFieldName(name)) {
    throw new ExpressionError(
      `Field reference {{${name}}} must match ${SQL_SAFE_FIELD_NAME_RE} (letters, digits, underscore; max ${MAX_SQL_SAFE_FIELD_NAME_LENGTH} characters)`,
      pos,
    );
  }
}

export function tokenize(src: string): Token[] {
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(
      `Expression is too long (over ${MAX_EXPRESSION_LENGTH} characters)`,
      MAX_EXPRESSION_LENGTH,
    );
  }
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    const single: Record<string, TokenKind> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbracket',
      ']': 'rbracket',
      ',': 'comma',
    };
    if (single[c]) {
      out.push({ kind: single[c]!, text: c, pos: i });
      i += 1;
      continue;
    }
    if (c === '.' && !isDigit(src[i + 1])) {
      out.push({ kind: 'dot', text: '.', pos: i });
      i += 1;
      continue;
    }
    if (c === '{' && src[i + 1] === '{') {
      const start = i;
      i += 2;
      const nameStart = i;
      while (i < src.length && !(src[i] === '}' && src[i + 1] === '}')) {
        i += 1;
      }
      if (i >= src.length) {
        throw new ExpressionError('Unclosed field reference, expected }}', start);
      }
      const name = src.slice(nameStart, i).trim();
      checkFieldName(name, start);
      out.push({ kind: 'field', text: name, value: name, pos: start });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      i += 1;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]!;
          value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          value += src[i];
          i += 1;
        }
      }
      if (i >= src.length) {
        throw new ExpressionError(
          `Unclosed text value, expected a closing ${quote}`,
          start,
        );
      }
      i += 1;
      out.push({ kind: 'str', text: src.slice(start, i), value, pos: start });
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) i += 1;
      if (
        (src[i] === 'e' || src[i] === 'E') &&
        (isDigit(src[i + 1]) ||
          ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2])))
      ) {
        i += 2;
        while (isDigit(src[i])) i += 1;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`Invalid number "${text}"`, start);
      }
      out.push({ kind: 'num', text, value, pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '<>', '~~', '&&', '||'].includes(two)) {
      out.push({ kind: 'op', text: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>=!'.includes(c)) {
      out.push({ kind: 'op', text: c, pos: i });
      i += 1;
      continue;
    }
    if (c === '$') {
      const start = i;
      i += 1;
      while (i < src.length && isIdentPart(src[i]!)) i += 1;
      out.push({ kind: 'dollar', text: src.slice(start, i).toLowerCase(), pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) i += 1;
      const text = src.slice(start, i);
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) {
        out.push({ kind: 'op', text: upper, pos: start });
      } else {
        out.push({ kind: 'ident', text, pos: start });
      }
      continue;
    }
    throw new ExpressionError(`Unexpected character "${c}"`, i);
  }
  out.push({ kind: 'eof', text: '', pos: src.length });
  return out;
}

const CMP: Record<string, BinOp> = {
  '==': '==',
  '=': '==',
  '!=': '!=',
  '<>': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

/**
 * Parse `src` into a syntax tree. Throws ExpressionError with a
 * position on syntax mistakes. Function names are lower-cased but not
 * resolved here; the checker knows the catalog.
 */
export function parseExpression(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;
  let depth = 0;

  const peek = (o = 0): Token => tokens[Math.min(i + o, tokens.length - 1)]!;
  const consume = (): Token => tokens[i++]!;
  const isOp = (text: string, o = 0) => peek(o).kind === 'op' && peek(o).text === text;
  function expect(kind: TokenKind, text?: string, what?: string): Token {
    const t = peek();
    if (t.kind !== kind || (text !== undefined && t.text !== text)) {
      throw new ExpressionError(
        `Expected ${what ?? text ?? kind}, got ${t.kind === 'eof' ? 'the end of the expression' : `"${t.text}"`}`,
        t.pos,
      );
    }
    return consume();
  }
  function enter(pos: number) {
    depth += 1;
    if (depth > MAX_DEPTH) {
      throw new ExpressionError('Expression is nested too deeply', pos);
    }
  }

  function parseOr(): Expr {
    enter(peek().pos);
    let left = parseAnd();
    while (isOp('OR') || isOp('||')) {
      const pos = consume().pos;
      left = { kind: 'binop', op: 'OR', left, right: parseAnd(), pos };
    }
    depth -= 1;
    return left;
  }
  function parseAnd(): Expr {
    let left = parseNot();
    while (isOp('AND') || isOp('&&')) {
      const pos = consume().pos;
      left = { kind: 'binop', op: 'AND', left, right: parseNot(), pos };
    }
    return left;
  }
  function parseNot(): Expr {
    if (isOp('NOT') || isOp('!')) {
      const pos = consume().pos;
      enter(pos);
      const arg = parseNot();
      depth -= 1;
      return { kind: 'unop', op: 'NOT', arg, pos };
    }
    return parseCompare();
  }
  function parseCompare(): Expr {
    const left = parseConcat();
    const t = peek();
    if (t.kind !== 'op') return left;
    const cmp = CMP[t.text];
    if (cmp) {
      consume();
      return { kind: 'binop', op: cmp, left, right: parseConcat(), pos: t.pos };
    }
    if (t.text === 'IS') {
      consume();
      let negated = false;
      if (isOp('NOT')) {
        consume();
        negated = true;
      }
      expect('op', 'NULL', 'NULL after IS');
      return { kind: 'isnull', arg: left, negated, pos: t.pos };
    }
    let negated = false;
    if (t.text === 'NOT' && ['IN', 'BETWEEN', 'LIKE', 'ILIKE'].includes(peek(1).text) && peek(1).kind === 'op') {
      consume();
      negated = true;
    }
    const k = peek();
    if (k.kind === 'op' && k.text === 'IN') {
      consume();
      let list: Expr;
      if (peek().kind === 'lparen') {
        const pos = consume().pos;
        const items = parseArgs('rparen');
        list = { kind: 'list', items, pos };
      } else {
        list = parseConcat();
      }
      return { kind: 'in', arg: left, list, negated, pos: k.pos };
    }
    if (k.kind === 'op' && k.text === 'BETWEEN') {
      consume();
      const low = parseConcat();
      expect('op', 'AND', 'AND in BETWEEN ... AND ...');
      const high = parseConcat();
      return { kind: 'between', arg: left, low, high, negated, pos: k.pos };
    }
    if (k.kind === 'op' && (k.text === 'LIKE' || k.text === 'ILIKE')) {
      consume();
      return {
        kind: 'like',
        arg: left,
        pattern: parseConcat(),
        negated,
        caseInsensitive: k.text === 'ILIKE',
        pos: k.pos,
      };
    }
    if (negated) {
      throw new ExpressionError('Expected IN, BETWEEN or LIKE after NOT', k.pos);
    }
    return left;
  }
  function parseConcat(): Expr {
    let left = parseAdd();
    while (isOp('~~')) {
      const pos = consume().pos;
      left = { kind: 'binop', op: '~~', left, right: parseAdd(), pos };
    }
    return left;
  }
  function parseAdd(): Expr {
    let left = parseMul();
    while (isOp('+') || isOp('-')) {
      const t = consume();
      left = { kind: 'binop', op: t.text as BinOp, left, right: parseMul(), pos: t.pos };
    }
    return left;
  }
  function parseMul(): Expr {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const t = consume();
      left = { kind: 'binop', op: t.text as BinOp, left, right: parseUnary(), pos: t.pos };
    }
    return left;
  }
  function parseUnary(): Expr {
    if (isOp('-')) {
      const pos = consume().pos;
      enter(pos);
      const arg = parseUnary();
      depth -= 1;
      // Fold a negative literal so `-5` is a number, not an operation.
      if (arg.kind === 'num') return { kind: 'num', value: -arg.value, pos };
      return { kind: 'unop', op: '-', arg, pos };
    }
    if (isOp('+')) {
      consume();
      return parseUnary();
    }
    return parsePostfix();
  }
  function parsePostfix(): Expr {
    let e = parsePrimary();
    for (;;) {
      if (peek().kind === 'dot') {
        const dot = consume();
        const name = expect('ident', undefined, 'a field name after "."');
        checkFieldName(name.text, name.pos);
        e = memberOf(e, name.text, dot.pos);
        continue;
      }
      if (peek().kind === 'lbracket' && (e.kind === 'feature' || e.kind === 'func' || e.kind === 'member')) {
        const lb = consume();
        const name = expect('str', undefined, 'a field name in quotes');
        expect('rbracket');
        checkFieldName(String(name.value), name.pos);
        e = memberOf(e, String(name.value), lb.pos);
        continue;
      }
      return e;
    }
  }
  function memberOf(object: Expr, name: string, pos: number): Expr {
    if (object.kind === 'feature') {
      return { kind: 'field', name, outer: true, pos: object.pos };
    }
    return { kind: 'member', object, name, pos };
  }
  function parseArgs(close: 'rparen' | 'rbracket'): Expr[] {
    const args: Expr[] = [];
    if (peek().kind !== close) {
      args.push(parseOr());
      while (peek().kind === 'comma') {
        consume();
        args.push(parseOr());
      }
    }
    expect(close, undefined, close === 'rparen' ? '")"' : '"]"');
    return args;
  }
  function parseCase(pos: number): Expr {
    let subject: Expr | null = null;
    if (!isOp('WHEN')) subject = parseOr();
    const whens: Array<{ when: Expr; then: Expr }> = [];
    while (isOp('WHEN')) {
      consume();
      const when = parseOr();
      expect('op', 'THEN', 'THEN');
      whens.push({ when, then: parseOr() });
    }
    if (whens.length === 0) {
      throw new ExpressionError('CASE needs at least one WHEN ... THEN ...', peek().pos);
    }
    let otherwise: Expr | null = null;
    if (isOp('ELSE')) {
      consume();
      otherwise = parseOr();
    }
    expect('op', 'END', 'END to close CASE');
    return { kind: 'case', subject, whens, otherwise, pos };
  }
  function parsePrimary(): Expr {
    const t = peek();
    switch (t.kind) {
      case 'num':
        consume();
        return { kind: 'num', value: t.value as number, pos: t.pos };
      case 'str':
        consume();
        return { kind: 'str', value: t.value as string, pos: t.pos };
      case 'field':
        consume();
        return { kind: 'field', name: t.value as string, outer: false, pos: t.pos };
      case 'dollar':
        consume();
        if (t.text === '$feature') return { kind: 'feature', pos: t.pos };
        throw new ExpressionError(
          `${t.text} is not available here; use $feature, or layer('name') for another layer`,
          t.pos,
        );
      case 'lbracket': {
        consume();
        enter(t.pos);
        const items = parseArgs('rbracket');
        depth -= 1;
        return { kind: 'list', items, pos: t.pos };
      }
      case 'lparen': {
        consume();
        const e = parseOr();
        expect('rparen', undefined, '")"');
        return e;
      }
      case 'op':
        if (t.text === 'TRUE' || t.text === 'FALSE') {
          consume();
          return { kind: 'bool', value: t.text === 'TRUE', pos: t.pos };
        }
        if (t.text === 'NULL') {
          consume();
          return { kind: 'null', pos: t.pos };
        }
        // WHEN in value position, followed by "(", is the Arcade
        // function When(cond, value, ..., default). Inside CASE the
        // branch keyword is consumed before a value is parsed.
        if (t.text === 'WHEN' && peek(1).kind === 'lparen') {
          consume();
          consume();
          enter(t.pos);
          const args = parseArgs('rparen');
          depth -= 1;
          return { kind: 'func', name: 'when', args, pos: t.pos };
        }
        if (t.text === 'CASE') {
          consume();
          enter(t.pos);
          const e = parseCase(t.pos);
          depth -= 1;
          return e;
        }
        break;
      case 'ident': {
        consume();
        if (peek().kind !== 'lparen') {
          throw new ExpressionError(
            `"${t.text}" is not a function call or a value. Fields are written {{${t.text}}}, text is written in quotes`,
            t.pos,
          );
        }
        consume();
        enter(t.pos);
        const args = parseArgs('rparen');
        depth -= 1;
        return { kind: 'func', name: t.text.toLowerCase(), args, pos: t.pos };
      }
      default:
        break;
    }
    throw new ExpressionError(
      t.kind === 'eof' ? 'Unexpected end of expression' : `Unexpected "${t.text}"`,
      t.pos,
    );
  }

  const result = parseOr();
  if (peek().kind !== 'eof') {
    const t = peek();
    throw new ExpressionError(`Unexpected "${t.text}"`, t.pos);
  }
  return result;
}
