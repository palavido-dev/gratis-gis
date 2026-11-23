// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Arcade to GratisGIS expressions, for web maps imported from ArcGIS.
 *
 * Covers single-expression Arcade, which is most label and popup
 * expressions: `$feature` fields, operators, IIf / When / Decode,
 * the text, math and date functions, and the common FeatureSet
 * shapes (FeatureSetByName, FeatureSetByRelationshipName, Filter with
 * a SQL string, OrderBy, Intersects, Count, Sum and friends).
 *
 * Where Arcade and this language differ in meaning, the translation
 * adjusts rather than copying the name: Arcade counts positions and
 * months from 0, its Weekday starts on Sunday, Mid and Find take
 * 0-based positions, and Count of text is its length.
 *
 * Anything else (variables, loops, statements, functions that have no
 * counterpart) is refused with a reason, so the importer can say what
 * it dropped instead of importing something that means another thing.
 */

import { ExpressionError, type Expr } from './ast';
import { parseExpression } from './parser';
import { printExpression } from './printer';

export type ArcadeTranslation = { expression: string } | { error: string };

class Untranslatable extends Error {}

const num = (value: number, pos = 0): Expr => ({ kind: 'num', value, pos });
const str = (value: string, pos = 0): Expr => ({ kind: 'str', value, pos });
const call = (name: string, args: Expr[], pos = 0): Expr => ({ kind: 'func', name, args, pos });
const bin = (op: Extract<Expr, { kind: 'binop' }>['op'], left: Expr, right: Expr): Expr => ({
  kind: 'binop',
  op,
  left,
  right,
  pos: left.pos,
});

/** Statement-level Arcade this translator does not take. */
function rejectStatements(src: string): string | null {
  const code = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  if (/\bvar\s+\w/.test(code)) return 'it declares variables';
  if (/\b(for|while)\s*\(/.test(code)) return 'it uses a loop';
  if (/\bif\s*\(/.test(code)) return 'it uses if statements; IIf or When translate';
  if (/\bfunction\s+\w/.test(code)) return 'it defines a function';
  if (/;\s*\S/.test(code)) return 'it has more than one statement';
  if (/`/.test(code)) return 'it uses a template literal';
  return null;
}

/**
 * A SQL where clause from an Arcade Filter, such as "status = 'open'".
 * Bare identifiers become fields; Arcade's @variables are refused.
 */
function sqlWhere(sql: string): Expr {
  if (/@\w/.test(sql)) throw new Untranslatable('the Filter uses an @variable');
  const keywords = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'BETWEEN', 'TRUE', 'FALSE']);
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      if (end < 0) throw new Untranslatable('the Filter has an unclosed quote');
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      const word = sql.slice(i, j);
      out += keywords.has(word.toUpperCase()) ? word : `{{${word}}}`;
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return parseExpression(out);
  } catch {
    throw new Untranslatable(`the Filter clause "${sql}" was not understood`);
  }
}

/** Arcade date format tokens to format_date's. */
function dateFormat(f: string): string {
  return f.replace(/Y+/g, (m) => (m.length === 2 ? 'YY' : 'YYYY'));
}

function isFeatureSet(e: Expr): boolean {
  return (
    e.kind === 'func' &&
    [
      'layer',
      'related',
      'filter',
      'order_by',
      'top',
      'intersecting',
      'within_distance',
      'featuresetbyname',
      'featuresetbyrelationshipname',
      'intersects',
      'orderby',
    ].includes(e.name)
  );
}

function rewrite(e: Expr): Expr {
  switch (e.kind) {
    case 'func':
      return rewriteFunc({ ...e, args: e.args.map(rewrite) });
    case 'member':
      return { ...e, object: rewrite(e.object) };
    case 'list':
      return { ...e, items: e.items.map(rewrite) };
    case 'unop':
      return { ...e, arg: rewrite(e.arg) };
    case 'binop':
      return { ...e, left: rewrite(e.left), right: rewrite(e.right) };
    case 'isnull':
      return { ...e, arg: rewrite(e.arg) };
    case 'in':
      return { ...e, arg: rewrite(e.arg), list: rewrite(e.list) };
    case 'between':
      return { ...e, arg: rewrite(e.arg), low: rewrite(e.low), high: rewrite(e.high) };
    case 'like':
      return { ...e, arg: rewrite(e.arg), pattern: rewrite(e.pattern) };
    case 'case':
      return {
        ...e,
        subject: e.subject ? rewrite(e.subject) : null,
        whens: e.whens.map((w) => ({ when: rewrite(w.when), then: rewrite(w.then) })),
        otherwise: e.otherwise ? rewrite(e.otherwise) : null,
      };
    default:
      return e;
  }
}

function fieldArg(e: Expr | undefined, fn: string): Expr {
  if (!e) throw new Untranslatable(`${fn}() needs a field`);
  if (e.kind === 'str') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.value)) throw new Untranslatable(`${fn}() names a field that is not a plain identifier`);
    return { kind: 'field', name: e.value, outer: false, pos: e.pos };
  }
  throw new Untranslatable(`${fn}() with a computed field is not supported`);
}

function rewriteFunc(e: Extract<Expr, { kind: 'func' }>): Expr {
  const a = e.args;
  switch (e.name) {
    case 'mid':
      // Arcade positions start at 0.
      return call('substr', [a[0]!, bin('+', a[1] ?? num(0), num(1)), ...(a[2] ? [a[2]] : [])], e.pos);
    case 'find':
      // Find(search, text) is 0-based and -1 when missing.
      if (a.length > 2) throw new Untranslatable('Find() with a start position is not supported');
      return bin('-', call('index_of', [a[1]!, a[0]!]), num(1));
    case 'month':
      return bin('-', call('month', a), num(1));
    case 'weekday':
      // Arcade: Sunday 0 to Saturday 6.
      return bin('%', call('weekday', a), num(7));
    case 'count':
      return a[0] && isFeatureSet(a[0]) ? call('count', a) : call('length', a);
    case 'concatenate':
      if (a[0]?.kind === 'list') return call('join', [a[0], a[1] ?? str('')]);
      return call('concat', a);
    case 'text':
      if (a.length < 2) return call('text', a);
      if (a[1]!.kind !== 'str') throw new Untranslatable('Text() with a computed format is not supported');
      if (/[#0]/.test(a[1]!.value)) {
        const dec = (a[1]!.value.split('.')[1] ?? '').replace(/[^#0]/g, '').length;
        return call('format_number', [a[0]!, num(dec)]);
      }
      return call('format_date', [a[0]!, str(dateFormat(a[1]!.value))]);
    case 'datediff':
      if (a.length === 2) return bin('*', call('date_diff', [a[0]!, a[1]!, str('seconds')]), num(1000));
      return call('date_diff', a.slice(0, 3));
    case 'dateadd':
      if (a.length === 2) return call('date_add', [a[0]!, bin('/', a[1]!, num(1000)), str('seconds')]);
      return call('date_add', a.slice(0, 3));
    case 'replace':
      if (a[3] && !(a[3].kind === 'bool' && a[3].value)) {
        throw new Untranslatable('Replace() of only the first match is not supported');
      }
      return call('replace', a.slice(0, 3));
    case 'featuresetbyname':
      if (a[1]?.kind !== 'str') throw new Untranslatable('FeatureSetByName() needs a layer name');
      return call('layer', [a[1]]);
    case 'featuresetbyrelationshipname':
      if (a[1]?.kind !== 'str') throw new Untranslatable('FeatureSetByRelationshipName() needs a name');
      return call('related', [a[1]]);
    case 'featuresetbyid':
    case 'featuresetbyportalitem':
      throw new Untranslatable(`${e.name}() points at an ArcGIS item; use layer('name') after importing it`);
    case 'filter':
      if (a[1]?.kind !== 'str') throw new Untranslatable('Filter() needs a SQL string');
      return call('filter', [a[0]!, sqlWhere(a[1].value)]);
    case 'orderby': {
      if (a[1]?.kind !== 'str') throw new Untranslatable('OrderBy() needs a field');
      const [field, dir] = a[1].value.trim().split(/\s+/) as [string, string?];
      return call('order_by', [
        a[0]!,
        fieldArg(str(field), 'OrderBy'),
        str((dir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'),
      ]);
    }
    case 'intersects': {
      const [x, y] = a;
      const set = x && isFeatureSet(x) ? x : y;
      return call('intersecting', [set!]);
    }
    case 'sum':
    case 'mean':
    case 'average':
    case 'min':
    case 'max':
    case 'stdev':
      if (a[0] && isFeatureSet(a[0])) {
        if (e.name === 'stdev') throw new Untranslatable('Stdev() is not supported');
        return call(e.name === 'mean' || e.name === 'average' ? 'avg' : e.name, [a[0], fieldArg(a[1], e.name)]);
      }
      if (e.name === 'sum' || e.name === 'mean' || e.name === 'average' || e.name === 'stdev') {
        throw new Untranslatable(`${e.name}() of values is not supported`);
      }
      return e;
    case 'distinct':
      throw new Untranslatable('Distinct() is not supported; count_distinct() covers counting');
    case 'buffer':
    case 'geometry':
    case 'centroid':
    case 'union':
    case 'difference':
      throw new Untranslatable(`${e.name}() is not supported`);
    default:
      return e;
  }
}

export function translateArcade(src: string): ArcadeTranslation {
  let text = src.trim();
  text = text.replace(/^return\s+/i, '').replace(/;\s*$/, '');
  text = text.replace(/TextFormatting\.NewLine/g, "'\\n'");
  // Profile globals the FeatureSet functions take; the name is what matters.
  text = text.replace(/\$(map|datastore|layer)\b/g, 'null');
  const why = rejectStatements(text);
  if (why) return { error: `This Arcade expression was not translated: ${why}` };
  let ast: Expr;
  try {
    ast = parseExpression(text);
  } catch (e) {
    return {
      error: `This Arcade expression was not translated: ${e instanceof ExpressionError ? e.message : 'it did not parse'}`,
    };
  }
  try {
    return { expression: printExpression(rewrite(ast)) };
  } catch (e) {
    if (e instanceof Untranslatable) return { error: `This Arcade expression was not translated: ${e.message}` };
    throw e;
  }
}
