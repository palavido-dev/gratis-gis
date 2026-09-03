// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny expression language used by derived-layer attribute-filter
 * and field-calculator steps (#75).
 *
 * Grammar (informally, with left-associative binary ops):
 *
 *   expr        := orExpr
 *   orExpr      := andExpr ( ('OR' | '||' (logical, not concat)) andExpr )*
 *   andExpr     := notExpr ( 'AND' notExpr )*
 *   notExpr     := 'NOT' notExpr
 *                | compareExpr
 *   compareExpr := concatExpr ( ('==' | '!=' | '<' | '<=' | '>' | '>=') concatExpr )?
 *   concatExpr  := addExpr ( '~~' addExpr )*               // ~~ = string concat
 *   addExpr     := mulExpr ( ('+' | '-') mulExpr )*
 *   mulExpr     := unary  ( ('*' | '/' | '%') unary )*
 *   unary       := '-' unary | primary
 *   primary     := number
 *                | string
 *                | 'true' | 'false' | 'null'
 *                | field ('{{' name '}}')
 *                | functionCall
 *                | '(' expr ')'
 *   functionCall := IDENT '(' [ expr ( ',' expr )* ] ')'
 *
 * Built-in functions (case-insensitive): upper, lower, length,
 * concat, coalesce, abs, round, floor, ceil, if.
 *
 * Why a custom mini-language rather than reusing a parser like
 * jsep: the universe is so small (no regex, no array indexing, no
 * member access, no closures) that a 250-line hand-rolled parser
 * is simpler than wiring up + locking down a general one.  We also
 * need a SQL emitter that escapes safely; controlling the AST
 * shape end-to-end avoids surprises from operators the host
 * grammar accepts but we can't translate.
 *
 * Why string concat is `~~` instead of `||`: SQL uses `||` for
 * string concat but JS / TS authors expect `||` to be logical OR.
 * To avoid landmines, we pick `~~` as a non-ambiguous operator and
 * keep `OR` as the only spelling of logical OR.  Callers who want
 * concat can also use the `concat(a, b, ...)` function.
 */

/**
 * What the type-checker knows about a value.
 *
 * `date` is ISO-8601 text. It compares as text (which is correct for
 * ISO-8601, in the SQL emitter and the JS evaluator alike) and is
 * refused by arithmetic: `{{sample_date}} - 1` used to type-check as
 * `unknown` and then produce NaN in JS and a cast error in SQL. What a
 * date minus a number should mean (days? seconds?) is a language
 * decision nobody has made, so until someone does, it is an error
 * with a sentence rather than a silent wrong answer.
 *
 * `list` is a multi_select value. It supports only `==` and `!=`
 * against text, meaning "is exactly this one selection"; membership
 * tests have no operator yet and are refused rather than guessed.
 */
export type FieldRefType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'date'
  | 'list'
  | 'unknown';

/** Field reference -> SQL column. Hand off to the emitter; the
 *  expression engine never touches column quoting itself. */
export interface FieldRef {
  name: string;
  type: FieldRefType;
}

/**
 * The type-checker's view of a declared layer field. One mapping so
 * every caller that builds FieldRefs from a FeatureField schema agrees;
 * two of them used to cast `f.type` to the four-member union and
 * silently carry 'date' and 'multi_select' through as if they were
 * one of those.
 */
export function fieldRefTypeFor(
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'multi_select',
): FieldRefType {
  return fieldType === 'multi_select' ? 'list' : fieldType;
}

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'field'; name: string }
  | { kind: 'unop'; op: '-' | 'NOT'; arg: Expr }
  | { kind: 'binop'; op: BinOp; left: Expr; right: Expr }
  | { kind: 'func'; name: string; args: Expr[] };

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'AND'
  | 'OR'
  | '~~';

const FUNCTIONS = new Set([
  'upper',
  'lower',
  'length',
  'concat',
  'coalesce',
  'abs',
  'round',
  'floor',
  'ceil',
  'if',
]);

export class ExpressionError extends Error {
  /** Offset into the source string where the error starts. */
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

// ---- Tokenizer ---------------------------------------------------

type TokenKind =
  | 'num'
  | 'str'
  | 'ident'
  | 'field'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'op'
  | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  /** Numeric / string literal value once parsed. */
  value?: number | string;
  pos: number;
}

const SINGLE_CHAR_OPS = '+-*/%';
const KEYWORD_OPS = new Set(['AND', 'OR', 'NOT']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '(') {
      out.push({ kind: 'lparen', text: '(', pos: i });
      i += 1;
      continue;
    }
    if (c === ')') {
      out.push({ kind: 'rparen', text: ')', pos: i });
      i += 1;
      continue;
    }
    if (c === ',') {
      out.push({ kind: 'comma', text: ',', pos: i });
      i += 1;
      continue;
    }
    // {{ field }}
    if (c === '{' && src[i + 1] === '{') {
      const start = i;
      i += 2;
      const nameStart = i;
      while (i < src.length && !(src[i] === '}' && src[i + 1] === '}')) {
        i += 1;
      }
      if (i >= src.length) {
        throw new ExpressionError(
          'Unclosed field reference, expected }}',
          start,
        );
      }
      const name = src.slice(nameStart, i).trim();
      if (name.length === 0) {
        throw new ExpressionError('Empty field reference {{}}', start);
      }
      out.push({ kind: 'field', text: name, value: name, pos: start });
      i += 2;
      continue;
    }
    // String literal
    if (c === "'") {
      const start = i;
      i += 1;
      let value = '';
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
        } else {
          value += src[i];
          i += 1;
        }
      }
      if (i >= src.length) {
        throw new ExpressionError(
          'Unclosed string literal, expected closing apostrophe',
          start,
        );
      }
      i += 1; // closing quote
      out.push({ kind: 'str', text: src.slice(start, i), value, pos: start });
      continue;
    }
    // Number literal
    if (c >= '0' && c <= '9') {
      const start = i;
      while (
        i < src.length &&
        ((src[i]! >= '0' && src[i]! <= '9') || src[i] === '.')
      ) {
        i += 1;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`Invalid number "${text}"`, start);
      }
      out.push({ kind: 'num', text, value, pos: start });
      continue;
    }
    // Compound ops: == != <= >= ~~
    if (
      (c === '=' && src[i + 1] === '=') ||
      (c === '!' && src[i + 1] === '=') ||
      (c === '<' && src[i + 1] === '=') ||
      (c === '>' && src[i + 1] === '=') ||
      (c === '~' && src[i + 1] === '~')
    ) {
      const text = src.slice(i, i + 2);
      out.push({ kind: 'op', text, pos: i });
      i += 2;
      continue;
    }
    // Single-char comparison
    if (c === '<' || c === '>') {
      out.push({ kind: 'op', text: c, pos: i });
      i += 1;
      continue;
    }
    // Single-char arithmetic
    if (SINGLE_CHAR_OPS.includes(c)) {
      out.push({ kind: 'op', text: c, pos: i });
      i += 1;
      continue;
    }
    // Identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) {
        i += 1;
      }
      const text = src.slice(start, i);
      const upper = text.toUpperCase();
      if (KEYWORD_OPS.has(upper)) {
        out.push({ kind: 'op', text: upper, pos: start });
      } else if (upper === 'TRUE' || upper === 'FALSE') {
        out.push({
          kind: 'ident',
          text: upper,
          value: upper === 'TRUE' ? 1 : 0,
          pos: start,
        });
      } else if (upper === 'NULL') {
        out.push({ kind: 'ident', text: 'NULL', pos: start });
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

// ---- Parser ------------------------------------------------------

/**
 * Parse `src` into an AST.  Throws ExpressionError with a position
 * on syntactic mistakes; the caller is responsible for showing the
 * position to the user via a caret.
 */
export function parseExpression(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;

  function peek(): Token {
    return tokens[i]!;
  }
  function consume(): Token {
    return tokens[i++]!;
  }
  function expect(kind: TokenKind, text?: string): Token {
    const t = peek();
    if (t.kind !== kind || (text !== undefined && t.text !== text)) {
      throw new ExpressionError(
        `Expected ${text ?? kind}, got "${t.text}"`,
        t.pos,
      );
    }
    return consume();
  }

  function parseOr(): Expr {
    let left = parseAnd();
    while (peek().kind === 'op' && peek().text === 'OR') {
      consume();
      const right = parseAnd();
      left = { kind: 'binop', op: 'OR', left, right };
    }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseNot();
    while (peek().kind === 'op' && peek().text === 'AND') {
      consume();
      const right = parseNot();
      left = { kind: 'binop', op: 'AND', left, right };
    }
    return left;
  }
  function parseNot(): Expr {
    if (peek().kind === 'op' && peek().text === 'NOT') {
      consume();
      const arg = parseNot();
      return { kind: 'unop', op: 'NOT', arg };
    }
    return parseCompare();
  }
  function parseCompare(): Expr {
    const left = parseConcat();
    const t = peek();
    if (
      t.kind === 'op' &&
      (t.text === '==' ||
        t.text === '!=' ||
        t.text === '<' ||
        t.text === '<=' ||
        t.text === '>' ||
        t.text === '>=')
    ) {
      consume();
      const right = parseConcat();
      return { kind: 'binop', op: t.text as BinOp, left, right };
    }
    return left;
  }
  function parseConcat(): Expr {
    let left = parseAdd();
    while (peek().kind === 'op' && peek().text === '~~') {
      consume();
      const right = parseAdd();
      left = { kind: 'binop', op: '~~', left, right };
    }
    return left;
  }
  function parseAdd(): Expr {
    let left = parseMul();
    while (
      peek().kind === 'op' &&
      (peek().text === '+' || peek().text === '-')
    ) {
      const op = consume().text as '+' | '-';
      const right = parseMul();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }
  function parseMul(): Expr {
    let left = parseUnary();
    while (
      peek().kind === 'op' &&
      (peek().text === '*' || peek().text === '/' || peek().text === '%')
    ) {
      const op = consume().text as '*' | '/' | '%';
      const right = parseUnary();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }
  function parseUnary(): Expr {
    if (peek().kind === 'op' && peek().text === '-') {
      consume();
      return { kind: 'unop', op: '-', arg: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Expr {
    const t = peek();
    if (t.kind === 'num') {
      consume();
      return { kind: 'num', value: t.value as number };
    }
    if (t.kind === 'str') {
      consume();
      return { kind: 'str', value: t.value as string };
    }
    if (t.kind === 'field') {
      consume();
      return { kind: 'field', name: t.value as string };
    }
    if (t.kind === 'ident') {
      if (t.text === 'TRUE' || t.text === 'FALSE') {
        consume();
        return { kind: 'bool', value: t.text === 'TRUE' };
      }
      if (t.text === 'NULL') {
        consume();
        return { kind: 'null' };
      }
      const name = t.text.toLowerCase();
      consume();
      if (!FUNCTIONS.has(name)) {
        throw new ExpressionError(`Unknown function "${t.text}"`, t.pos);
      }
      expect('lparen');
      const args: Expr[] = [];
      if (peek().kind !== 'rparen') {
        args.push(parseOr());
        while (peek().kind === 'comma') {
          consume();
          args.push(parseOr());
        }
      }
      expect('rparen');
      return { kind: 'func', name, args };
    }
    if (t.kind === 'lparen') {
      consume();
      const e = parseOr();
      expect('rparen');
      return e;
    }
    throw new ExpressionError(
      t.kind === 'eof' ? 'Unexpected end of expression' : `Unexpected token "${t.text}"`,
      t.pos,
    );
  }

  const result = parseOr();
  if (peek().kind !== 'eof') {
    const t = peek();
    throw new ExpressionError(`Unexpected token "${t.text}"`, t.pos);
  }
  return result;
}

// ---- Validation --------------------------------------------------

/**
 * Walk the AST and check that every field reference resolves
 * against `schema`, function arities match, and operators are
 * applied to compatible types.  Returns an array of error
 * messages keyed to source positions; an empty array means the
 * expression is valid.
 *
 * Light type-checking only: numeric vs string vs boolean.  We
 * don't try to be SQL-strict; the SQL emitter handles coercions
 * via casts.  Goal here is to catch "you typed `acres + name`
 * but name is a string" before the user saves.
 */
export function validateExpression(
  expr: Expr,
  schema: FieldRef[],
): string[] {
  const errors: string[] = [];
  const fieldsByName = new Map(schema.map((f) => [f.name, f]));

  /** Human names for the type words that reach an error message. */
  const shown = (t: FieldRefType) =>
    t === 'list' ? 'a list' : t === 'date' ? 'a date' : t === 'unknown' ? 'an unknown type' : `a ${t}`;

  function inferType(e: Expr): FieldRefType {
    switch (e.kind) {
      case 'num':
        return 'number';
      case 'str':
        return 'string';
      case 'bool':
        return 'boolean';
      case 'null':
        return 'unknown';
      case 'field': {
        const ref = fieldsByName.get(e.name);
        if (!ref) {
          errors.push(`Field {{${e.name}}} does not exist on the schema`);
          return 'unknown';
        }
        return ref.type;
      }
      case 'unop':
        if (e.op === '-') {
          const t = inferType(e.arg);
          if (t !== 'number' && t !== 'unknown') {
            errors.push(`Unary minus requires a number (got ${shown(t)})`);
          }
          return 'number';
        }
        // NOT
        return 'boolean';
      case 'binop': {
        const lt = inferType(e.left);
        const rt = inferType(e.right);
        if (e.op === 'AND' || e.op === 'OR') return 'boolean';
        if (
          e.op === '==' ||
          e.op === '!=' ||
          e.op === '<' ||
          e.op === '<=' ||
          e.op === '>' ||
          e.op === '>='
        ) {
          if (lt !== 'unknown' && rt !== 'unknown') {
            const equality = e.op === '==' || e.op === '!=';
            // A date is ISO text, so date-with-date and date-with-a-text
            // literal both order correctly as text. A list is only ever
            // "exactly this selection" against text; ordering a list
            // means nothing and is refused.
            const textLike = (t: FieldRefType) => t === 'string' || t === 'date';
            const ok =
              (lt === rt && lt !== 'list') ||
              (textLike(lt) && textLike(rt)) ||
              (equality && lt === 'list' && rt === 'string') ||
              (equality && lt === 'string' && rt === 'list');
            if (!ok) {
              errors.push(
                lt === 'list' || rt === 'list'
                  ? `Comparison ${e.op} is not supported for a list field; only == and != against a text value are`
                  : `Comparison ${e.op} between ${shown(lt)} and ${shown(rt)} is unsupported; cast one side first`,
              );
            }
          }
          return 'boolean';
        }
        if (e.op === '~~') return 'string';
        // Arithmetic. Dates and lists are refused outright (see
        // FieldRefType); text is refused too, which this checker never
        // did before even though its own docblock names `acres + name`
        // as the thing it exists to catch.
        for (const [t, side] of [
          [lt, e.left],
          [rt, e.right],
        ] as const) {
          if (t === 'number' || t === 'unknown') continue;
          const what = side.kind === 'field' ? `Field {{${side.name}}}` : 'A value';
          errors.push(
            t === 'date'
              ? `${what} is a date and cannot be used in arithmetic`
              : t === 'list'
                ? `${what} is a list and cannot be used in arithmetic`
                : `${what} is ${shown(t)} and cannot be used in arithmetic; use concat() to join text`,
          );
        }
        return 'number';
      }
      case 'func': {
        const arity = e.args.length;
        switch (e.name) {
          case 'upper':
          case 'lower':
            if (arity !== 1) errors.push(`${e.name}() takes one argument`);
            return 'string';
          case 'length':
            if (arity !== 1) errors.push('length() takes one argument');
            return 'number';
          case 'concat':
            return 'string';
          case 'coalesce':
            if (arity < 2) {
              errors.push('coalesce() takes at least two arguments');
            }
            return inferType(e.args[0]!) === 'unknown' ? 'unknown' : inferType(e.args[0]!);
          case 'abs':
          case 'round':
          case 'floor':
          case 'ceil':
            if (arity !== 1) errors.push(`${e.name}() takes one argument`);
            return 'number';
          case 'if':
            if (arity !== 3) {
              errors.push('if(cond, then, else) takes three arguments');
            }
            return inferType(e.args[1]!);
          default:
            errors.push(`Unknown function ${e.name}()`);
            return 'unknown';
        }
      }
    }
  }

  inferType(expr);
  return errors;
}

// ---- SQL emitter -------------------------------------------------

/**
 * Compile an AST to a SQL fragment + a parameter array.  The
 * caller appends the params to its outer query's parameter list
 * and splices the emitted SQL where appropriate (a WHERE clause
 * for filter, a SELECT projection for calculate-field).
 *
 * `columnSql(name)` resolves a field reference to a SQL expression.
 * For the derived-layer tools this returns
 * `(properties->>'name')::TYPE` based on the field's declared
 * type; callers can substitute a different shape for non-properties
 * schemas.
 *
 * `paramOffset` matches the existing tool generator convention:
 * the first `$N` we emit is `$${paramOffset + 1}`.
 */
export interface CompileResult {
  sql: string;
  params: unknown[];
}

export function compileExpression(
  expr: Expr,
  columnSql: (fieldName: string) => string,
  paramOffset: number,
): CompileResult {
  const params: unknown[] = [];

  function emit(e: Expr): string {
    switch (e.kind) {
      case 'num':
        // Numbers are inlined safely after a Number() round-trip
        // through the tokenizer; no SQL injection risk.
        return String(e.value);
      case 'str': {
        params.push(e.value);
        return `$${paramOffset + params.length}`;
      }
      case 'bool':
        return e.value ? 'TRUE' : 'FALSE';
      case 'null':
        return 'NULL';
      case 'field':
        return columnSql(e.name);
      case 'unop':
        if (e.op === '-') return `(-${emit(e.arg)})`;
        return `(NOT ${emit(e.arg)})`;
      case 'binop': {
        const l = emit(e.left);
        const r = emit(e.right);
        switch (e.op) {
          case 'AND':
            return `(${l} AND ${r})`;
          case 'OR':
            return `(${l} OR ${r})`;
          case '==':
            return `(${l} = ${r})`;
          case '!=':
            return `(${l} <> ${r})`;
          case '<':
          case '<=':
          case '>':
          case '>=':
            return `(${l} ${e.op} ${r})`;
          case '~~':
            return `(${l} || ${r})`;
          case '+':
          case '-':
          case '*':
          case '/':
          case '%':
            return `(${l} ${e.op} ${r})`;
        }
        // exhaustive switch above
        return '';
      }
      case 'func': {
        const args = e.args.map(emit);
        switch (e.name) {
          case 'upper':
            return `UPPER(${args[0]})`;
          case 'lower':
            return `LOWER(${args[0]})`;
          case 'length':
            return `LENGTH(${args[0]})`;
          case 'concat':
            return args.length === 0
              ? `''`
              : `(${args.join(' || ')})`;
          case 'coalesce':
            return `COALESCE(${args.join(', ')})`;
          case 'abs':
            return `ABS(${args[0]})`;
          case 'round':
            return `ROUND(${args[0]})`;
          case 'floor':
            return `FLOOR(${args[0]})`;
          case 'ceil':
            return `CEIL(${args[0]})`;
          case 'if':
            return `(CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END)`;
          default:
            // validated upstream
            return 'NULL';
        }
      }
    }
  }

  const sql = emit(expr);
  return { sql, params };
}

/**
 * Evaluate an AST against a single feature's properties.  Used by
 * the attribute-table Calculate Field flow (#83) so we can compute
 * the new value for each row server-side without round-tripping
 * through SQL for every cell.  Faster path than `compileExpression`
 * when the caller already has the property values in memory (e.g.
 * after fetching a paged result for preview).
 *
 * Type coercions match the SQL emitter's intent so the previewed
 * value lines up with what a SQL-based path would produce:
 *   - numeric ops coerce both sides to Number (NaN sentinels for
 *     empty / non-numeric inputs; consumers can clean those up
 *     downstream)
 *   - string ops coerce via String()
 *   - comparisons follow JS semantics (which match SQL's lexical
 *     vs numeric behavior for the value types we accept)
 */
export function evaluateExpression(
  expr: Expr,
  props: Record<string, unknown>,
): unknown {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'str':
      return expr.value;
    case 'bool':
      return expr.value;
    case 'null':
      return null;
    case 'field':
      return props[expr.name] ?? null;
    case 'unop': {
      const v = evaluateExpression(expr.arg, props);
      if (expr.op === '-') return -Number(v);
      return !v;
    }
    case 'binop': {
      const l = evaluateExpression(expr.left, props);
      const r = evaluateExpression(expr.right, props);
      switch (expr.op) {
        case 'AND':
          return Boolean(l) && Boolean(r);
        case 'OR':
          return Boolean(l) || Boolean(r);
        case '==':
          // NULL == NULL is NULL in SQL but for our purposes,
          // align with strict-equality for predictability.
          return l === r;
        case '!=':
          return l !== r;
        // Text against text orders as text, which is what the SQL
        // emitter does for a text column and the only reading under
        // which two ISO dates compare correctly. Coercing both sides
        // to Number, as this used to, made `{{d}} < '2021-01-01'`
        // NaN-compare to false in the JS preview while the SQL said
        // yes: the two runtimes disagreed on every date filter.
        case '<':
          return typeof l === 'string' && typeof r === 'string'
            ? l < r
            : Number(l) < Number(r);
        case '<=':
          return typeof l === 'string' && typeof r === 'string'
            ? l <= r
            : Number(l) <= Number(r);
        case '>':
          return typeof l === 'string' && typeof r === 'string'
            ? l > r
            : Number(l) > Number(r);
        case '>=':
          return typeof l === 'string' && typeof r === 'string'
            ? l >= r
            : Number(l) >= Number(r);
        case '~~':
          return String(l) + String(r);
        case '+':
          return Number(l) + Number(r);
        case '-':
          return Number(l) - Number(r);
        case '*':
          return Number(l) * Number(r);
        case '/': {
          const rn = Number(r);
          if (rn === 0) return null;
          return Number(l) / rn;
        }
        case '%': {
          const rn = Number(r);
          if (rn === 0) return null;
          return Number(l) % rn;
        }
      }
      return null;
    }
    case 'func': {
      const args = expr.args.map((a) => evaluateExpression(a, props));
      switch (expr.name) {
        case 'upper':
          return String(args[0] ?? '').toUpperCase();
        case 'lower':
          return String(args[0] ?? '').toLowerCase();
        case 'length':
          return String(args[0] ?? '').length;
        case 'concat':
          return args.map((a) => (a == null ? '' : String(a))).join('');
        case 'coalesce':
          for (const a of args) if (a != null) return a;
          return null;
        case 'abs':
          return Math.abs(Number(args[0]));
        case 'round':
          return Math.round(Number(args[0]));
        case 'floor':
          return Math.floor(Number(args[0]));
        case 'ceil':
          return Math.ceil(Number(args[0]));
        case 'if':
          return args[0] ? args[1] : args[2];
        default:
          return null;
      }
    }
  }
}

/**
 * Helper: walk an AST and collect every field reference.  Used by
 * the dependency extractor + the schema validator to know which
 * columns an expression touches.
 */
export function collectFieldRefs(expr: Expr): string[] {
  const out = new Set<string>();
  function visit(e: Expr) {
    switch (e.kind) {
      case 'field':
        out.add(e.name);
        return;
      case 'unop':
        visit(e.arg);
        return;
      case 'binop':
        visit(e.left);
        visit(e.right);
        return;
      case 'func':
        for (const a of e.args) visit(a);
        return;
      default:
        return;
    }
  }
  visit(expr);
  return [...out];
}
