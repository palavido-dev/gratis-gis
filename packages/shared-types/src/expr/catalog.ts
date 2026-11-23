// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The function catalog: every built-in function with its signature,
 * help text, SQL form and JavaScript form side by side, so the two
 * runtimes cannot drift apart without a reviewer seeing both halves.
 *
 * The builder UI reads this catalog for its function list, so the
 * descriptions are user-facing text.
 *
 * A few functions are special forms and are handled by the checker,
 * compiler and evaluator directly because their arguments are lazy or
 * typed as a whole: if, when, decode, coalesce, is_empty, and the data
 * access functions in data.ts.
 */

import type { ValueType } from './ast';
import {
  addUnits,
  datePart,
  dateUnit,
  diffUnits,
  formatDate,
  parseFormat,
  startOf,
  todayIn,
  type DatePart,
  type DateUnit,
  type FormatPiece,
} from './dates';
import {
  areaUnit,
  centroid,
  geodesicArea,
  geodesicLength,
  lengthUnit,
  AREA_UNITS,
  LENGTH_UNITS,
  type Geometry,
} from './geo';
import { sqlNumLit, type SqlArg } from './sqlconv';
import {
  chars,
  DateVal,
  fin,
  groupThousands,
  initcap,
  isFeature,
  parseIsoDate,
  roundNum,
  roundText,
  splitPart,
  toBool,
  toDate,
  toNum,
  toText,
  trimChars,
  utcMs,
  daysInMonth,
  type FeatureVal,
  type Val,
} from './values';

/**
 * Parameter kinds. Value kinds are converted before the function body
 * runs; literal kinds must be written as a literal and arrive already
 * normalized.
 */
export type ParamKind =
  | 'number'
  | 'text'
  | 'date'
  | 'boolean'
  | 'list'
  /** Any scalar, passed through with its static type. */
  | 'any'
  | 'feature'
  | 'date-unit'
  | 'length-unit'
  | 'area-unit'
  | 'date-format';

export const LITERAL_KINDS = new Set<ParamKind>([
  'date-unit',
  'length-unit',
  'area-unit',
  'date-format',
]);

export type Category =
  | 'logic'
  | 'text'
  | 'math'
  | 'date'
  | 'list'
  | 'conversion'
  | 'geometry'
  | 'data';

export interface SqlFnCtx {
  /** Bind a value as a query parameter; returns `$n::cast`. */
  param(v: unknown, cast: string): string;
  /** SQL for the evaluation time zone (an IANA name). */
  timeZone: string;
}

export interface JsFnCtx {
  now: number;
  timeZone: string;
}

export interface Variant {
  signature: string;
  params: ParamKind[];
  /** How many trailing params may be left out. */
  optional?: number;
  /** Kind of any further arguments; makes the function variadic. */
  rest?: ParamKind;
  /** Choose this variant for these argument types. */
  match?: (types: ValueType[]) => boolean;
  returns: ValueType | ((types: ValueType[]) => ValueType);
  sql(a: SqlArg[], c: SqlFnCtx): string;
  js(a: Val[], c: JsFnCtx): Val;
}

export interface FnSpec {
  name: string;
  aliases?: string[];
  category: Category;
  description: string;
  example?: string;
  variants: Variant[];
}

/** Normalize a literal-only argument; null when it is not valid. */
export function normalizeLiteral(kind: ParamKind, raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  switch (kind) {
    case 'date-unit':
      return dateUnit(raw);
    case 'length-unit':
      return lengthUnit(raw);
    case 'area-unit':
      return areaUnit(raw);
    case 'date-format':
      return parseFormat(raw);
    default:
      return raw;
  }
}

export function literalHint(kind: ParamKind): string {
  switch (kind) {
    case 'date-unit':
      return "a unit in quotes: 'years', 'quarters', 'months', 'weeks', 'days', 'hours', 'minutes' or 'seconds'";
    case 'length-unit':
      return `a unit in quotes: ${Object.keys(LENGTH_UNITS).map((u) => `'${u}'`).join(', ')}`;
    case 'area-unit':
      return `a unit in quotes: ${Object.keys(AREA_UNITS).map((u) => `'${u}'`).join(', ')}`;
    case 'date-format':
      return "a pattern in quotes, such as 'MMM D, YYYY'";
    default:
      return 'a value in quotes';
  }
}

// ---- helpers -----------------------------------------------------

const n = (v: Val | undefined) => (v ?? null) as number | null;
const s = (v: Val | undefined) => (v ?? null) as string | null;
const d = (v: Val | undefined) => (v ?? null) as DateVal | null;
const anyNull = (...vs: Array<Val | undefined>) => vs.some((v) => v === null || v === undefined);

/** Null-propagating numeric function. */
function numFn(f: (...x: number[]) => number) {
  return (a: Val[]): Val => (anyNull(...a) ? null : fin(f(...(a as number[]))));
}

/** SQL fragment builder that leaves a null argument null. */
const sqlCall = (fn: string) => (a: SqlArg[]) => `${fn}(${a.map((x) => x.sql).join(', ')})`;

const UNIT_SQL: Record<DateUnit, string> = {
  years: "interval '1 year'",
  quarters: "interval '3 months'",
  months: "interval '1 month'",
  weeks: "interval '1 week'",
  days: "interval '1 day'",
  hours: "interval '1 hour'",
  minutes: "interval '1 minute'",
  seconds: "interval '1 second'",
};
const UNIT_SECONDS: Partial<Record<DateUnit, number>> = {
  weeks: 604800,
  days: 86400,
  hours: 3600,
  minutes: 60,
  seconds: 1,
};
const utc = (x: string) => `(${x} AT TIME ZONE 'UTC')`;
const fromUtc = (x: string) => `(${x} AT TIME ZONE 'UTC')`;

const PART_SQL: Record<DatePart, string> = {
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  weekday: 'isodow',
  day_of_year: 'doy',
  week: 'week',
};

const TRUNC_SQL: Record<DateUnit, string> = {
  years: 'year',
  quarters: 'quarter',
  months: 'month',
  weeks: 'week',
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
  seconds: 'second',
};

const FORMAT_SQL: Record<string, string> = {
  YYYY: 'YYYY',
  YY: 'YY',
  MMMM: 'FMMonth',
  MMM: 'Mon',
  MM: 'MM',
  M: 'FMMM',
  dddd: 'FMDay',
  ddd: 'Dy',
  DD: 'DD',
  D: 'FMDD',
  HH: 'HH24',
  H: 'FMHH24',
  hh: 'HH12',
  h: 'FMHH12',
  mm: 'MI',
  ss: 'SS',
  A: 'AM',
};

/** A to_char pattern; literal text is double-quoted. */
function toCharPattern(pieces: FormatPiece[]): string {
  return pieces
    .map((p) =>
      'text' in p ? `"${p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : FORMAT_SQL[p.token],
    )
    .join('');
}

function geomOf(v: Val | undefined): Geometry | null {
  return isFeature(v) ? ((v as FeatureVal).geometry as Geometry | null) : null;
}

const part = (p: DatePart, desc: string, example: string): FnSpec => ({
  name: p,
  category: 'date',
  description: desc,
  example,
  variants: [
    {
      signature: `${p}(date)`,
      params: ['date'],
      returns: 'number',
      sql: (a) => `extract(${PART_SQL[p]} from ${utc(a[0]!.sql)})::double precision`,
      js: (a) => (a[0] === null ? null : datePart(d(a[0])!.ms, p)),
    },
  ],
});

// ---- catalog -----------------------------------------------------

export const FUNCTIONS: FnSpec[] = [
  // Logic. if, when, decode, coalesce and is_empty are special forms;
  // their entries here carry the help text and arity only.
  {
    name: 'if',
    aliases: ['iif'],
    category: 'logic',
    description: 'Returns the second value when the condition is true, otherwise the third.',
    example: "if({{status}} == 'open', 'Needs work', 'Done')",
    variants: [special('if(condition, then, else)')],
  },
  {
    name: 'when',
    category: 'logic',
    description:
      'Checks conditions in order and returns the value after the first true one. The last argument is the default.',
    example: "when({{score}} >= 90, 'A', {{score}} >= 80, 'B', 'C')",
    variants: [special('when(condition, value, ..., default)')],
  },
  {
    name: 'decode',
    category: 'logic',
    description:
      'Compares a value with each match in turn and returns the result paired with the first match. The last argument is the default.',
    example: "decode({{code}}, 1, 'Low', 2, 'Medium', 3, 'High', 'Unknown')",
    variants: [special('decode(value, match, result, ..., default)')],
  },
  {
    name: 'coalesce',
    aliases: ['defaultvalue'],
    category: 'logic',
    description: 'Returns the first value that is not empty (null).',
    example: "coalesce({{nickname}}, {{name}}, 'Unnamed')",
    variants: [special('coalesce(value, fallback, ...)')],
  },
  {
    name: 'is_empty',
    aliases: ['isempty'],
    category: 'logic',
    description: 'True when the value is null, empty text, or an empty list.',
    example: 'is_empty({{notes}})',
    variants: [special('is_empty(value)')],
  },

  // Text
  {
    name: 'upper',
    category: 'text',
    description: 'Text in capital letters.',
    example: 'upper({{name}})',
    variants: [
      {
        signature: 'upper(text)',
        params: ['text'],
        returns: 'string',
        sql: sqlCall('upper'),
        js: (a) => (a[0] === null ? null : s(a[0])!.toUpperCase()),
      },
    ],
  },
  {
    name: 'lower',
    category: 'text',
    description: 'Text in small letters.',
    example: 'lower({{email}})',
    variants: [
      {
        signature: 'lower(text)',
        params: ['text'],
        returns: 'string',
        sql: sqlCall('lower'),
        js: (a) => (a[0] === null ? null : s(a[0])!.toLowerCase()),
      },
    ],
  },
  {
    name: 'proper',
    aliases: ['initcap'],
    category: 'text',
    description: 'Capitalizes the first letter of each word.',
    example: 'proper({{street}})',
    variants: [
      {
        signature: 'proper(text)',
        params: ['text'],
        returns: 'string',
        sql: sqlCall('initcap'),
        js: (a) => (a[0] === null ? null : initcap(s(a[0])!)),
      },
    ],
  },
  {
    name: 'trim',
    category: 'text',
    description: 'Removes spaces, tabs and line breaks from both ends.',
    example: 'trim({{name}})',
    variants: [
      {
        signature: 'trim(text)',
        params: ['text'],
        returns: 'string',
        sql: (a) => `btrim(${a[0]!.sql}, E' \\t\\r\\n')`,
        js: (a) => (a[0] === null ? null : trimChars(s(a[0])!, true, true)),
      },
    ],
  },
  {
    name: 'ltrim',
    category: 'text',
    description: 'Removes spaces from the start.',
    variants: [
      {
        signature: 'ltrim(text)',
        params: ['text'],
        returns: 'string',
        sql: (a) => `ltrim(${a[0]!.sql}, E' \\t\\r\\n')`,
        js: (a) => (a[0] === null ? null : trimChars(s(a[0])!, true, false)),
      },
    ],
  },
  {
    name: 'rtrim',
    category: 'text',
    description: 'Removes spaces from the end.',
    variants: [
      {
        signature: 'rtrim(text)',
        params: ['text'],
        returns: 'string',
        sql: (a) => `rtrim(${a[0]!.sql}, E' \\t\\r\\n')`,
        js: (a) => (a[0] === null ? null : trimChars(s(a[0])!, false, true)),
      },
    ],
  },
  {
    name: 'length',
    category: 'text',
    description:
      'Number of characters in text. With $feature, the length of a line or the perimeter of a polygon, in the unit you give (meters by default).',
    example: "length({{name}})   length($feature, 'feet')",
    variants: [
      {
        signature: 'length($feature, unit?)',
        params: ['feature', 'length-unit'],
        optional: 1,
        match: (t) => t[0] === 'feature',
        returns: 'number',
        sql: (a) => {
          const g = a[0]!.sql;
          const per = LENGTH_UNITS[(a[1]?.lit as string) ?? 'meters']!;
          return `((CASE WHEN GeometryType(${g}) IN ('POLYGON', 'MULTIPOLYGON') THEN ST_Perimeter(${g}::geography, false) ELSE ST_Length(${g}::geography, false) END) / ${sqlNumLit(per)})`;
        },
        js: (a) => {
          const g = geomOf(a[0]!);
          if (!g) return null;
          const per = LENGTH_UNITS[(a[1] as string | undefined) ?? 'meters']!;
          return geodesicLength(g) / per;
        },
      },
      {
        signature: 'length(text)',
        params: ['text'],
        returns: 'number',
        sql: (a) => `char_length(${a[0]!.sql})::double precision`,
        js: (a) => (a[0] === null ? null : chars(s(a[0])!).length),
      },
    ],
  },
  {
    name: 'left',
    category: 'text',
    description: 'The first n characters.',
    example: 'left({{parcel_id}}, 3)',
    variants: [
      {
        signature: 'left(text, n)',
        params: ['text', 'number'],
        returns: 'string',
        sql: (a) => `left(${a[0]!.sql}, greatest(trunc(${a[1]!.sql}), 0)::int)`,
        js: (a) => (anyNull(...a) ? null : chars(s(a[0])!).slice(0, Math.max(Math.trunc(n(a[1])!), 0)).join('')),
      },
    ],
  },
  {
    name: 'right',
    category: 'text',
    description: 'The last n characters.',
    example: 'right({{phone}}, 4)',
    variants: [
      {
        signature: 'right(text, n)',
        params: ['text', 'number'],
        returns: 'string',
        sql: (a) => `right(${a[0]!.sql}, greatest(trunc(${a[1]!.sql}), 0)::int)`,
        js: (a) => {
          if (anyNull(...a)) return null;
          const k = Math.max(Math.trunc(n(a[1])!), 0);
          const c = chars(s(a[0])!);
          return k === 0 ? '' : c.slice(Math.max(c.length - k, 0)).join('');
        },
      },
    ],
  },
  {
    name: 'substr',
    aliases: ['mid', 'substring'],
    category: 'text',
    description: 'Part of the text, starting at a position (the first character is 1), optionally limited to a count.',
    example: 'substr({{code}}, 2, 3)',
    variants: [
      {
        signature: 'substr(text, start, count?)',
        params: ['text', 'number', 'number'],
        optional: 1,
        returns: 'string',
        sql: (a) =>
          a.length > 2
            ? `substr(${a[0]!.sql}, greatest(trunc(${a[1]!.sql}), 1)::int, greatest(trunc(${a[2]!.sql}) + least(trunc(${a[1]!.sql}) - 1, 0), 0)::int)`
            : `substr(${a[0]!.sql}, greatest(trunc(${a[1]!.sql}), 1)::int)`,
        js: (a) => {
          if (anyNull(...a)) return null;
          const c = chars(s(a[0])!);
          const start = Math.trunc(n(a[1])!);
          let from = Math.max(start, 1) - 1;
          if (a.length > 2) {
            const count = Math.max(Math.trunc(n(a[2])!) + Math.min(start - 1, 0), 0);
            return c.slice(from, from + count).join('');
          }
          return c.slice(from).join('');
        },
      },
    ],
  },
  {
    name: 'index_of',
    aliases: ['find', 'strpos'],
    category: 'text',
    description: 'Position of the search text inside the text, counting from 1. 0 when it is not found.',
    example: "index_of({{address}}, ' ')",
    variants: [
      {
        signature: 'index_of(text, search)',
        params: ['text', 'text'],
        returns: 'number',
        sql: (a) => `strpos(${a[0]!.sql}, ${a[1]!.sql})::double precision`,
        js: (a) => {
          if (anyNull(...a)) return null;
          const i = s(a[0])!.indexOf(s(a[1])!);
          return i < 0 ? 0 : chars(s(a[0])!.slice(0, i)).length + 1;
        },
      },
    ],
  },
  {
    name: 'replace',
    category: 'text',
    description: 'Replaces every occurrence of one piece of text with another.',
    example: "replace({{name}}, 'St.', 'Street')",
    variants: [
      {
        signature: 'replace(text, find, with)',
        params: ['text', 'text', 'text'],
        returns: 'string',
        sql: sqlCall('replace'),
        js: (a) => (anyNull(...a) ? null : s(a[1]) === '' ? s(a[0]) : s(a[0])!.split(s(a[1])!).join(s(a[2])!)),
      },
    ],
  },
  {
    name: 'concat',
    aliases: ['concatenate'],
    category: 'text',
    description: 'Joins values into one piece of text. Empty values are skipped.',
    example: "concat({{first}}, ' ', {{last}})",
    variants: [
      {
        signature: 'concat(value, ...)',
        params: [],
        rest: 'text',
        returns: 'string',
        sql: (a) => (a.length === 0 ? `''` : `concat(${a.map((x) => x.sql).join(', ')})`),
        js: (a) => a.map((x) => (x === null ? '' : (x as string))).join(''),
      },
    ],
  },
  {
    name: 'contains',
    category: 'text',
    description:
      'For text, true when it contains the search text, ignoring capital letters. For a list, true when the list includes the value.',
    example: "contains({{notes}}, 'damage')   contains({{species}}, 'oak')",
    variants: [
      {
        signature: 'contains(list, value)',
        params: ['list', 'text'],
        match: (t) => t[0] === 'list',
        returns: 'boolean',
        sql: (a) => `COALESCE(${a[1]!.sql} = ANY(${a[0]!.sql}), FALSE)`,
        js: (a) => (anyNull(...a) ? false : (a[0] as string[]).includes(s(a[1])!)),
      },
      {
        signature: 'contains(text, search)',
        params: ['text', 'text'],
        returns: 'boolean',
        sql: (a) => `COALESCE(strpos(lower(${a[0]!.sql}), lower(${a[1]!.sql})) > 0, FALSE)`,
        js: (a) => (anyNull(...a) ? false : s(a[0])!.toLowerCase().includes(s(a[1])!.toLowerCase())),
      },
    ],
  },
  {
    name: 'starts_with',
    aliases: ['startswith'],
    category: 'text',
    description: 'True when the text starts with the given text (capital letters matter).',
    example: "starts_with({{parcel_id}}, '12-')",
    variants: [
      {
        signature: 'starts_with(text, start)',
        params: ['text', 'text'],
        returns: 'boolean',
        sql: (a) => `COALESCE(starts_with(${a[0]!.sql}, ${a[1]!.sql}), FALSE)`,
        js: (a) => (anyNull(...a) ? false : s(a[0])!.startsWith(s(a[1])!)),
      },
    ],
  },
  {
    name: 'ends_with',
    aliases: ['endswith'],
    category: 'text',
    description: 'True when the text ends with the given text (capital letters matter).',
    example: "ends_with({{file}}, '.jpg')",
    variants: [
      {
        signature: 'ends_with(text, end)',
        params: ['text', 'text'],
        returns: 'boolean',
        sql: (a) => `COALESCE(right(${a[0]!.sql}, char_length(${a[1]!.sql})) = ${a[1]!.sql}, FALSE)`,
        js: (a) => (anyNull(...a) ? false : s(a[0])!.endsWith(s(a[1])!)),
      },
    ],
  },
  {
    name: 'pad_left',
    aliases: ['lpad'],
    category: 'text',
    description: 'Adds characters to the start until the text is n characters long (zeros for IDs, say). Longer text is left as is.',
    example: "pad_left({{lot}}, 4, '0')",
    variants: [
      {
        signature: 'pad_left(text, n, with?)',
        params: ['text', 'number', 'text'],
        optional: 1,
        returns: 'string',
        sql: (a) => `(CASE WHEN char_length(${a[0]!.sql}) >= trunc(${a[1]!.sql}) THEN ${a[0]!.sql} ELSE lpad(${a[0]!.sql}, trunc(${a[1]!.sql})::int, ${a[2]?.sql ?? `' '`}) END)`,
        js: (a) => padJs(a, true),
      },
    ],
  },
  {
    name: 'pad_right',
    aliases: ['rpad'],
    category: 'text',
    description: 'Adds characters to the end until the text is n characters long. Longer text is left as is.',
    variants: [
      {
        signature: 'pad_right(text, n, with?)',
        params: ['text', 'number', 'text'],
        optional: 1,
        returns: 'string',
        sql: (a) => `(CASE WHEN char_length(${a[0]!.sql}) >= trunc(${a[1]!.sql}) THEN ${a[0]!.sql} ELSE rpad(${a[0]!.sql}, trunc(${a[1]!.sql})::int, ${a[2]?.sql ?? `' '`}) END)`,
        js: (a) => padJs(a, false),
      },
    ],
  },
  {
    name: 'split_part',
    aliases: ['split'],
    category: 'text',
    description: 'Splits text on a separator and returns one piece, counting from 1 (or from the end with a negative number).',
    example: "split_part({{full_name}}, ' ', 1)",
    variants: [
      {
        signature: 'split_part(text, separator, n)',
        params: ['text', 'text', 'number'],
        returns: 'string',
        sql: (a) => `split_part(${a[0]!.sql}, ${a[1]!.sql}, trunc(${a[2]!.sql})::int)`,
        js: (a) => (anyNull(...a) ? null : splitPart(s(a[0])!, s(a[1])!, Math.trunc(n(a[2])!))),
      },
    ],
  },
  {
    name: 'format_number',
    category: 'text',
    description: 'A number as text with thousands separators and a fixed number of decimals.',
    example: 'format_number({{acres}}, 2)',
    variants: [
      {
        signature: 'format_number(number, decimals?)',
        params: ['number', 'number'],
        optional: 1,
        returns: 'string',
        sql: (a) => {
          const dec = a[1] ? `least(greatest(trunc(${a[1].sql}), 0), 10)::int` : '0';
          const r = `round(abs(${a[0]!.sql})::numeric, ${dec})::text`;
          return `(CASE WHEN ${a[0]!.sql} IS NULL${a[1] ? ` OR ${a[1].sql} IS NULL` : ''} THEN NULL ELSE (CASE WHEN round(${a[0]!.sql}::numeric, ${dec}) < 0 THEN '-' ELSE '' END) || regexp_replace(split_part(${r}, '.', 1), '(\\d)(?=(\\d{3})+$)', '\\1,', 'g') || (CASE WHEN ${dec} > 0 THEN '.' || split_part(${r}, '.', 2) ELSE '' END) END)`;
        },
        js: (a) => {
          if (a[0] === null || (a.length > 1 && a[1] === null)) return null;
          const dec = a.length > 1 ? Math.min(Math.max(Math.trunc(n(a[1])!), 0), 10) : 0;
          const neg = roundNum(n(a[0])!, dec) < 0;
          const txt = roundText(Math.abs(n(a[0])!), dec);
          const [i, f] = txt.split('.') as [string, string?];
          return `${neg ? '-' : ''}${groupThousands(i)}${dec > 0 ? `.${f}` : ''}`;
        },
      },
    ],
  },

  // Math
  {
    name: 'abs',
    category: 'math',
    description: 'The number without its sign.',
    variants: [
      { signature: 'abs(number)', params: ['number'], returns: 'number', sql: sqlCall('abs'), js: numFn(Math.abs) },
    ],
  },
  {
    name: 'round',
    category: 'math',
    description: 'Rounds to the given number of decimals (0 by default). Halves round away from zero.',
    example: 'round({{acres}}, 2)',
    variants: [
      {
        signature: 'round(number, decimals?)',
        params: ['number', 'number'],
        optional: 1,
        returns: 'number',
        sql: (a) =>
          `round(${a[0]!.sql}::numeric, ${a[1] ? `least(greatest(trunc(${a[1].sql}), -15), 15)::int` : '0'})::double precision`,
        js: (a) => {
          if (anyNull(...a)) return null;
          const dec = a.length > 1 ? Math.min(Math.max(Math.trunc(n(a[1])!), -15), 15) : 0;
          return roundNum(n(a[0])!, dec);
        },
      },
    ],
  },
  {
    name: 'floor',
    category: 'math',
    description: 'Rounds down to a whole number.',
    variants: [{ signature: 'floor(number)', params: ['number'], returns: 'number', sql: sqlCall('floor'), js: numFn(Math.floor) }],
  },
  {
    name: 'ceil',
    aliases: ['ceiling'],
    category: 'math',
    description: 'Rounds up to a whole number.',
    variants: [{ signature: 'ceil(number)', params: ['number'], returns: 'number', sql: sqlCall('ceil'), js: numFn(Math.ceil) }],
  },
  {
    name: 'trunc',
    category: 'math',
    description: 'Drops the decimals.',
    variants: [{ signature: 'trunc(number)', params: ['number'], returns: 'number', sql: sqlCall('trunc'), js: numFn(Math.trunc) }],
  },
  {
    name: 'sign',
    category: 'math',
    description: '-1, 0 or 1 by the sign of the number.',
    variants: [{ signature: 'sign(number)', params: ['number'], returns: 'number', sql: sqlCall('sign'), js: numFn(Math.sign) }],
  },
  {
    name: 'sqrt',
    category: 'math',
    description: 'Square root. Empty for a negative number.',
    variants: [
      {
        signature: 'sqrt(number)',
        params: ['number'],
        returns: 'number',
        sql: (a) => `(CASE WHEN ${a[0]!.sql} >= 0 THEN sqrt(${a[0]!.sql}) END)`,
        js: (a) => (a[0] === null || n(a[0])! < 0 ? null : Math.sqrt(n(a[0])!)),
      },
    ],
  },
  {
    name: 'power',
    aliases: ['pow'],
    category: 'math',
    description: 'A number raised to a power.',
    example: 'power({{radius}}, 2) * pi()',
    variants: [
      {
        signature: 'power(number, exponent)',
        params: ['number', 'number'],
        returns: 'number',
        sql: (a) => {
          const [b, e] = [a[0]!.sql, a[1]!.sql];
          return `(CASE WHEN ${b} < 0 AND ${e} <> trunc(${e}) THEN NULL WHEN ${b} = 0 AND ${e} < 0 THEN NULL WHEN abs(${e}) * ln(greatest(abs(${b}), 1e-300)) > 709 THEN NULL ELSE power(${b}, ${e}) END)`;
        },
        js: (a) => {
          if (anyNull(...a)) return null;
          const [b, e] = [n(a[0])!, n(a[1])!];
          if (b < 0 && e !== Math.trunc(e)) return null;
          if (b === 0 && e < 0) return null;
          if (Math.abs(e) * Math.log(Math.max(Math.abs(b), 1e-300)) > 709) return null;
          return fin(b ** e);
        },
      },
    ],
  },
  {
    name: 'exp',
    category: 'math',
    description: 'e raised to the number.',
    variants: [
      {
        signature: 'exp(number)',
        params: ['number'],
        returns: 'number',
        sql: (a) => `(CASE WHEN ${a[0]!.sql} <= 709 THEN exp(${a[0]!.sql}) END)`,
        js: (a) => (a[0] === null || n(a[0])! > 709 ? null : Math.exp(n(a[0])!)),
      },
    ],
  },
  {
    name: 'ln',
    aliases: ['log'],
    category: 'math',
    description: 'Natural logarithm. Empty for zero or less.',
    variants: [
      {
        signature: 'ln(number)',
        params: ['number'],
        returns: 'number',
        sql: (a) => `(CASE WHEN ${a[0]!.sql} > 0 THEN ln(${a[0]!.sql}) END)`,
        js: (a) => (a[0] === null || n(a[0])! <= 0 ? null : Math.log(n(a[0])!)),
      },
    ],
  },
  {
    name: 'log10',
    category: 'math',
    description: 'Base-10 logarithm. Empty for zero or less.',
    variants: [
      {
        signature: 'log10(number)',
        params: ['number'],
        returns: 'number',
        sql: (a) => `(CASE WHEN ${a[0]!.sql} > 0 THEN log(${a[0]!.sql}) END)`,
        js: (a) => (a[0] === null || n(a[0])! <= 0 ? null : Math.log10(n(a[0])!)),
      },
    ],
  },
  {
    name: 'pi',
    category: 'math',
    description: 'The number pi.',
    variants: [{ signature: 'pi()', params: [], returns: 'number', sql: () => 'pi()', js: () => Math.PI }],
  },
  {
    name: 'min',
    aliases: ['least'],
    category: 'math',
    description: 'The smallest of the numbers, ignoring empty ones. With a set, the smallest value across its rows.',
    example: 'min({{a}}, {{b}})',
    variants: [
      {
        signature: 'min(number, number, ...)',
        params: ['number'],
        rest: 'number',
        returns: 'number',
        sql: sqlCall('least'),
        js: (a) => {
          const v = (a as Array<number | null>).filter((x): x is number => x !== null);
          return v.length ? Math.min(...v) : null;
        },
      },
    ],
  },
  {
    name: 'max',
    aliases: ['greatest'],
    category: 'math',
    description: 'The largest of the numbers, ignoring empty ones. With a set, the largest value across its rows.',
    example: 'max({{a}}, {{b}})',
    variants: [
      {
        signature: 'max(number, number, ...)',
        params: ['number'],
        rest: 'number',
        returns: 'number',
        sql: sqlCall('greatest'),
        js: (a) => {
          const v = (a as Array<number | null>).filter((x): x is number => x !== null);
          return v.length ? Math.max(...v) : null;
        },
      },
    ],
  },
  {
    name: 'clamp',
    aliases: ['constrain'],
    category: 'math',
    description: 'Keeps a number between a low and a high limit.',
    example: 'clamp({{pct}}, 0, 100)',
    variants: [
      {
        signature: 'clamp(number, low, high)',
        params: ['number', 'number', 'number'],
        returns: 'number',
        sql: (a) => `(CASE WHEN ${a[0]!.sql} IS NULL THEN NULL ELSE least(greatest(${a[0]!.sql}, ${a[1]!.sql}), ${a[2]!.sql}) END)`,
        js: (a) => {
          if (a[0] === null) return null;
          let v = n(a[0])!;
          if (a[1] !== null) v = Math.max(v, n(a[1])!);
          if (a[2] !== null) v = Math.min(v, n(a[2])!);
          return v;
        },
      },
    ],
  },

  // Conversion
  {
    name: 'number',
    aliases: ['to_number'],
    category: 'conversion',
    description: 'Reads a value as a number. Text that is not a number becomes empty. A date becomes milliseconds since 1970.',
    example: "number({{lot_text}})",
    variants: [
      {
        signature: 'number(value)',
        params: ['any'],
        returns: 'number',
        sql: (a) => {
          switch (a[0]!.type) {
            case 'number':
              return a[0]!.sql;
            case 'boolean':
              return `(${a[0]!.sql})::int::double precision`;
            case 'date':
              return `(extract(epoch from ${a[0]!.sql}) * 1000)::double precision`;
            case 'null':
              return 'NULL::double precision';
            default:
              return `gg_expr_num(btrim(${a[0]!.sql}))`;
          }
        },
        js: (a) => (typeof a[0] === 'string' ? toNum(a[0].trim()) : toNum(a[0]!)),
      },
    ],
  },
  {
    name: 'text',
    aliases: ['to_text', 'string'],
    category: 'conversion',
    description: 'A value as text. Dates show as YYYY-MM-DD, or with the time when there is one.',
    example: "text({{count}}) ~~ ' trees'",
    variants: [
      {
        signature: 'text(value)',
        params: ['text'],
        returns: 'string',
        sql: (a) => a[0]!.sql,
        js: (a) => a[0]!,
      },
    ],
  },
  {
    name: 'boolean',
    aliases: ['to_boolean'],
    category: 'conversion',
    description: "Reads yes/no, true/false, 1/0 as true or false.",
    variants: [
      {
        signature: 'boolean(value)',
        params: ['any'],
        returns: 'boolean',
        sql: (a) => {
          switch (a[0]!.type) {
            case 'boolean':
              return a[0]!.sql;
            case 'number':
              return `(${a[0]!.sql} <> 0)`;
            case 'string':
            case 'unknown':
              return `gg_expr_bool(${a[0]!.sql})`;
            default:
              return 'NULL::boolean';
          }
        },
        js: (a) => (typeof a[0] === 'string' || typeof a[0] === 'number' || typeof a[0] === 'boolean' ? toBool(a[0]) : null),
      },
    ],
  },
  {
    name: 'to_date',
    category: 'conversion',
    description: "Reads text such as '2024-05-01' or '2024-05-01T14:30:00Z' as a date. Text without a time zone is read as UTC.",
    example: "to_date({{survey_day}})",
    variants: [
      {
        signature: 'to_date(text)',
        params: ['date'],
        returns: 'date',
        sql: (a) => a[0]!.sql,
        js: (a) => a[0]!,
      },
    ],
  },

  // Dates
  {
    name: 'now',
    category: 'date',
    description: 'The current date and time.',
    variants: [
      {
        signature: 'now()',
        params: [],
        returns: 'date',
        sql: () => 'now()',
        js: (_a, c) => new DateVal(c.now),
      },
    ],
  },
  {
    name: 'today',
    category: 'date',
    description: "Today's date in the portal's time zone, with no time.",
    example: 'date_diff(today(), {{installed}}, \'years\')',
    variants: [
      {
        signature: 'today()',
        params: [],
        returns: 'date',
        sql: (_a, c) => fromUtc(`date_trunc('day', now() AT TIME ZONE ${c.timeZone})`),
        js: (_a, c) => new DateVal(todayIn(c.timeZone, c.now)),
      },
    ],
  },
  {
    name: 'date',
    aliases: ['make_date'],
    category: 'date',
    description: 'A date from a year, month and day, or from text.',
    example: 'date(2024, 7, 1)',
    variants: [
      {
        signature: 'date(text)',
        params: ['date'],
        match: (t) => t.length === 1,
        returns: 'date',
        sql: (a) => a[0]!.sql,
        js: (a) => a[0]!,
      },
      {
        signature: 'date(year, month, day)',
        params: ['number', 'number', 'number'],
        returns: 'date',
        sql: (a) => {
          const [y, m, dd] = a.map((x) => `trunc(${x.sql})::int`) as [string, string, string];
          return `(CASE WHEN ${y} BETWEEN 1 AND 9999 AND ${m} BETWEEN 1 AND 12 AND ${dd} BETWEEN 1 AND extract(day from (make_date(${y}, ${m}, 1) + interval '1 month - 1 day'))::int THEN make_timestamptz(${y}, ${m}, ${dd}, 0, 0, 0, 'UTC') END)`;
        },
        js: (a) => {
          if (anyNull(...a)) return null;
          const [y, m, dd] = (a as number[]).map(Math.trunc) as [number, number, number];
          if (y < 1 || y > 9999 || m < 1 || m > 12 || dd < 1 || dd > daysInMonth(y, m)) return null;
          return new DateVal(utcMs(y, m, dd));
        },
      },
    ],
  },
  {
    name: 'date_add',
    aliases: ['dateadd'],
    category: 'date',
    description:
      "Adds an amount of time to a date. Use a negative amount to go back. Months, quarters and years take whole numbers; adding a month to the 31st lands on the month's last day.",
    example: "date_add({{inspected}}, 1, 'years')",
    variants: [
      {
        signature: 'date_add(date, amount, unit)',
        params: ['date', 'number', 'date-unit'],
        returns: 'date',
        sql: (a) => {
          const unit = a[2]!.lit as DateUnit;
          const amount = UNIT_SECONDS[unit] !== undefined ? a[1]!.sql : `trunc(${a[1]!.sql})`;
          return fromUtc(`(${utc(a[0]!.sql)} + (${amount} * ${UNIT_SQL[unit]}))`);
        },
        js: (a) => (a[0] === null || a[1] === null ? null : new DateVal(addUnits(d(a[0])!.ms, n(a[1])!, a[2] as DateUnit))),
      },
    ],
  },
  {
    name: 'date_diff',
    aliases: ['datediff'],
    category: 'date',
    description:
      'The time from the second date to the first, in a unit. Days, hours and smaller units can have decimals; months, quarters and years count whole units that have fully passed.',
    example: "date_diff(today(), {{installed}}, 'years')",
    variants: [
      {
        signature: 'date_diff(later, earlier, unit)',
        params: ['date', 'date', 'date-unit'],
        returns: 'number',
        sql: (a) => {
          const unit = a[2]!.lit as DateUnit;
          const secs = UNIT_SECONDS[unit];
          if (secs !== undefined) {
            return `((extract(epoch from ${a[0]!.sql}) - extract(epoch from ${a[1]!.sql}))::double precision / ${sqlNumLit(secs)})`;
          }
          const months = `gg_expr_month_diff(${a[0]!.sql}, ${a[1]!.sql})`;
          return unit === 'months'
            ? `${months}::double precision`
            : `trunc(${months}::double precision / ${unit === 'quarters' ? 3 : 12})`;
        },
        js: (a) => (a[0] === null || a[1] === null ? null : diffUnits(d(a[0])!.ms, d(a[1])!.ms, a[2] as DateUnit)),
      },
    ],
  },
  {
    name: 'start_of',
    aliases: ['date_trunc'],
    category: 'date',
    description: "The start of the year, quarter, month, week (Monday), day, hour or minute the date falls in.",
    example: "start_of({{reported}}, 'months')",
    variants: [
      {
        signature: 'start_of(date, unit)',
        params: ['date', 'date-unit'],
        returns: 'date',
        sql: (a) => fromUtc(`date_trunc('${TRUNC_SQL[a[1]!.lit as DateUnit]}', ${utc(a[0]!.sql)})`),
        js: (a) => (a[0] === null ? null : new DateVal(startOf(d(a[0])!.ms, a[1] as DateUnit))),
      },
    ],
  },
  part('year', 'The year of a date.', 'year({{built}})'),
  part('quarter', 'The quarter of a date, 1 to 4.', 'quarter({{reported}})'),
  part('month', 'The month of a date, 1 to 12.', 'month({{reported}})'),
  part('day', 'The day of the month, 1 to 31.', 'day({{reported}})'),
  part('hour', 'The hour, 0 to 23, in UTC.', 'hour({{observed}})'),
  part('minute', 'The minute, 0 to 59.', 'minute({{observed}})'),
  part('second', 'The second, 0 to 59.', 'second({{observed}})'),
  part('weekday', 'The day of the week, Monday 1 to Sunday 7.', 'weekday({{reported}})'),
  part('day_of_year', 'The day of the year, 1 to 366.', 'day_of_year({{observed}})'),
  part('week', 'The ISO week number, 1 to 53.', 'week({{observed}})'),
  {
    name: 'format_date',
    category: 'date',
    description:
      "A date as text in your own pattern. YYYY year, MM month (MMM Jan, MMMM January), DD day (D without a zero), dddd weekday (ddd Mon), HH hour (hh 12-hour, A AM/PM), mm minutes, ss seconds. Put other words in [brackets].",
    example: "format_date({{inspected}}, 'MMM D, YYYY')",
    variants: [
      {
        signature: 'format_date(date, pattern)',
        params: ['date', 'date-format'],
        returns: 'string',
        sql: (a, c) => `to_char(${utc(a[0]!.sql)}, ${c.param(toCharPattern(a[1]!.lit as FormatPiece[]), 'text')})`,
        js: (a) => (a[0] === null ? null : formatDate(d(a[0])!.ms, a[1] as unknown as FormatPiece[])),
      },
    ],
  },

  // Lists (multi-select fields)
  {
    name: 'count',
    category: 'list',
    description: 'How many values a list holds. With a set of related or nearby rows, how many rows.',
    example: 'count({{species}})',
    variants: [
      {
        signature: 'count(list)',
        params: ['list'],
        returns: 'number',
        sql: (a) => `COALESCE(cardinality(${a[0]!.sql}), 0)::double precision`,
        js: (a) => (a[0] === null ? 0 : (a[0] as string[]).length),
      },
    ],
  },
  {
    name: 'join',
    category: 'list',
    description: "A list's values as one piece of text, with a separator (', ' by default).",
    example: "join({{species}}, '; ')",
    variants: [
      {
        signature: 'join(list, separator?)',
        params: ['list', 'text'],
        optional: 1,
        returns: 'string',
        sql: (a) => `array_to_string(${a[0]!.sql}, ${a[1]?.sql ?? `', '`})`,
        js: (a) => (a[0] === null || a[1] === null ? null : (a[0] as string[]).join(a.length > 1 ? s(a[1])! : ', ')),
      },
    ],
  },
  {
    name: 'any_of',
    category: 'list',
    description: 'True when the list includes at least one of the values.',
    example: "any_of({{hazards}}, 'fire', 'flood')",
    variants: [
      {
        signature: 'any_of(list, value, ...)',
        params: ['list', 'text'],
        rest: 'text',
        returns: 'boolean',
        sql: (a) => `COALESCE(${a[0]!.sql} && ARRAY[${a.slice(1).map((x) => x.sql).join(', ')}]::text[], FALSE)`,
        js: (a) => (a[0] === null ? false : a.slice(1).some((v) => v !== null && (a[0] as string[]).includes(v as string))),
      },
    ],
  },
  {
    name: 'all_of',
    category: 'list',
    description: 'True when the list includes every one of the values.',
    example: "all_of({{checks}}, 'gps', 'photo')",
    variants: [
      {
        signature: 'all_of(list, value, ...)',
        params: ['list', 'text'],
        rest: 'text',
        returns: 'boolean',
        sql: (a) => `COALESCE(${a[0]!.sql} @> ARRAY[${a.slice(1).map((x) => x.sql).join(', ')}]::text[], FALSE)`,
        js: (a) => (a[0] === null || a.slice(1).some((v) => v === null) ? false : a.slice(1).every((v) => (a[0] as string[]).includes(v as string))),
      },
    ],
  },

  // Geometry of the current feature
  {
    name: 'area',
    category: 'geometry',
    description: "The area of a polygon on the earth's surface, in the unit you give (square meters by default).",
    example: "area($feature, 'acres')",
    variants: [
      {
        signature: 'area($feature, unit?)',
        params: ['feature', 'area-unit'],
        optional: 1,
        returns: 'number',
        sql: (a) => `(ST_Area(${a[0]!.sql}::geography, false) / ${sqlNumLit(AREA_UNITS[(a[1]?.lit as string) ?? 'square-meters']!)})`,
        js: (a) => {
          const g = geomOf(a[0]!);
          return g ? geodesicArea(g) / AREA_UNITS[(a[1] as string | undefined) ?? 'square-meters']! : null;
        },
      },
    ],
  },
  {
    name: 'x',
    aliases: ['longitude'],
    category: 'geometry',
    description: 'The longitude of a point, or of the center of a line or polygon.',
    example: 'round(x($feature), 5)',
    variants: [
      {
        signature: 'x($feature)',
        params: ['feature'],
        returns: 'number',
        sql: (a) => `ST_X(ST_Centroid(${a[0]!.sql}))`,
        js: (a) => centroid(geomOf(a[0]!))?.[0] ?? null,
      },
    ],
  },
  {
    name: 'y',
    aliases: ['latitude'],
    category: 'geometry',
    description: 'The latitude of a point, or of the center of a line or polygon.',
    variants: [
      {
        signature: 'y($feature)',
        params: ['feature'],
        returns: 'number',
        sql: (a) => `ST_Y(ST_Centroid(${a[0]!.sql}))`,
        js: (a) => centroid(geomOf(a[0]!))?.[1] ?? null,
      },
    ],
  },
  {
    name: 'geometry_type',
    category: 'geometry',
    description: 'Point, LineString, Polygon, or the Multi- form.',
    variants: [
      {
        signature: 'geometry_type($feature)',
        params: ['feature'],
        returns: 'string',
        sql: (a) => `substr(ST_GeometryType(${a[0]!.sql}), 4)`,
        js: (a) => geomOf(a[0]!)?.type ?? null,
      },
    ],
  },
];

function special(signature: string): Variant {
  return {
    signature,
    params: [],
    returns: 'unknown',
    sql: () => 'NULL',
    js: () => null,
  };
}

function padJs(a: Val[], left: boolean): Val {
  if (a[0] === null || a[1] === null || (a.length > 2 && a[2] === null)) return null;
  const c = chars(s(a[0])!);
  const width = Math.trunc(n(a[1])!);
  if (c.length >= width) return s(a[0])!;
  const fill = chars(a.length > 2 ? s(a[2])! : ' ');
  if (fill.length === 0) return left ? c.slice(0, width).join('') : c.slice(0, width).join('');
  const need = width - c.length;
  let padding = '';
  for (let i = 0; i < need; i += 1) padding += fill[i % fill.length];
  return left ? padding + s(a[0])! : s(a[0])! + padding;
}

/** Functions by lower-case name and alias. */
export const FUNCTION_INDEX: Map<string, FnSpec> = new Map();
for (const f of FUNCTIONS) {
  FUNCTION_INDEX.set(f.name, f);
  for (const al of f.aliases ?? []) FUNCTION_INDEX.set(al, f);
}

export const SPECIAL_FORMS = new Set(['if', 'when', 'decode', 'coalesce', 'is_empty']);

// Re-exported for the evaluator, which converts arguments itself.
export { toDate, toNum, toText, toBool, parseIsoDate };
