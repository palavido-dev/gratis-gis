// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime values and conversions for the JavaScript evaluator.
 *
 * Every rule here has a twin in the SQL compiler (sql.ts) and in the
 * gg_expr_* database functions. When one changes, the other must, and
 * expr-parity.pg.spec.ts runs the same expressions through both.
 *
 * Rules worth knowing:
 *   - Numbers come from text only when the whole text is a number
 *     (`^-?(digits[.digits]|.digits)(e±digits)?$`); "n/a" is null.
 *   - Dates are instants. Text without an offset is read as UTC. A
 *     date shows as `YYYY-MM-DD` when it falls exactly on UTC
 *     midnight, otherwise as `YYYY-MM-DDTHH:MM:SSZ`.
 *   - A number shows the way Postgres prints a double: shortest
 *     round-trip digits, exponent form below 1e-4 or from 1e15 up.
 */

import type { FieldRefType } from './ast';

/** A date value: milliseconds since the epoch, UTC. */
export class DateVal {
  constructor(readonly ms: number) {}
}

/** A feature (`$feature`, or one row of a set). */
export interface FeatureVal {
  kind: 'feature';
  properties: Record<string, unknown>;
  geometry: unknown;
  /** Declared fields, so a member read can type the value. */
  fields: Array<{ name: string; type: FieldRefType }>;
}

/** A set of rows: a related table, another layer, a filtered set. */
export interface SetVal {
  kind: 'set';
  rows: FeatureVal[];
  fields: Array<{ name: string; type: FieldRefType }>;
}

export type Val =
  | null
  | number
  | string
  | boolean
  | DateVal
  | string[]
  | FeatureVal
  | SetVal;

export const NUMERIC_TEXT_RE = /^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

/** ISO 8601 shapes accepted as dates; mirrored in gg_expr_ts. */
export const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

export const DAY_MS = 86_400_000;

export function isDate(v: unknown): v is DateVal {
  return v instanceof DateVal;
}
export function isFeature(v: unknown): v is FeatureVal {
  return typeof v === 'object' && v !== null && (v as FeatureVal).kind === 'feature';
}
export function isSet(v: unknown): v is SetVal {
  return typeof v === 'object' && v !== null && (v as SetVal).kind === 'set';
}

/** Text form of a stored attribute, as Postgres `->>` renders it. */
export function rawText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? numText(v) : null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

export function parseNumText(t: string): number | null {
  if (!NUMERIC_TEXT_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseBoolText(t: string): boolean | null {
  const s = t.trim().toLowerCase();
  if (s === 'true' || s === 't' || s === 'yes' || s === 'y' || s === '1') return true;
  if (s === 'false' || s === 'f' || s === 'no' || s === 'n' || s === '0') return false;
  return null;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Milliseconds for a UTC calendar date and time, years 1 to 9999. */
export function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, ms);
  return dt.getTime();
}

export function parseIsoDate(t: string): DateVal | null {
  const m = ISO_DATE_RE.exec(t.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  const frac = m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0;
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  let ms = utcMs(y, mo, d, h, mi, s, frac);
  const off = m[8];
  if (off && off !== 'Z' && off !== 'z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 15 || om > 59) return null;
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  return new DateVal(ms);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Canonical text for a date; see the module header. */
export function dateText(d: DateVal): string {
  const dt = new Date(d.ms);
  const date = `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  if (((d.ms % DAY_MS) + DAY_MS) % DAY_MS === 0) return date;
  return `${date}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}Z`;
}

/** A number as Postgres prints a double. */
export function numText(n: number): string {
  if (Object.is(n, -0)) return '-0';
  const [mant, expStr] = n.toExponential().split('e') as [string, string];
  const exp = Number(expStr);
  if (exp < -4 || exp >= 15) {
    return `${mant}e${exp < 0 ? '-' : '+'}${pad(Math.abs(exp))}`;
  }
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '');
  let out: string;
  if (exp >= 0) {
    const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    const frac = digits.slice(exp + 1);
    out = frac ? `${int}.${frac}` : int;
  } else {
    out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return neg ? `-${out}` : out;
}

/** Finite numbers only; NaN and Infinity become null. */
export function fin(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

// ---- Conversions -------------------------------------------------

export function toNum(v: Val): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return fin(v);
  if (typeof v === 'string') return parseNumText(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isDate(v)) return v.ms;
  return null;
}

export function toText(v: Val): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numText(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isDate(v)) return dateText(v);
  if (Array.isArray(v)) return v.join(', ');
  return null;
}

export function toDate(v: Val): DateVal | null {
  if (v === null) return null;
  if (isDate(v)) return v;
  if (typeof v === 'string') return parseIsoDate(v);
  return null;
}

export function toBool(v: Val): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return parseBoolText(v);
  if (typeof v === 'number') return v !== 0;
  return null;
}

export function toList(v: Val): string[] | null {
  if (v === null) return null;
  if (Array.isArray(v)) return v;
  return null;
}

/**
 * A stored attribute read as its declared type: the JavaScript side of
 * the SQL compiler's column reads.
 */
export function readField(raw: unknown, type: FieldRefType): Val {
  if (type === 'list') {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) {
      return raw
        .filter((x) => x !== null && x !== undefined)
        .map((x) => (typeof x === 'string' ? x : (rawText(x) ?? '')));
    }
    if (typeof raw === 'string') return raw === '' ? [] : [raw];
    return [rawText(raw) ?? ''];
  }
  const t = rawText(raw);
  if (t === null) return null;
  switch (type) {
    case 'number':
      return parseNumText(t);
    case 'boolean':
      return parseBoolText(t);
    case 'date':
      return parseIsoDate(t);
    default:
      return t;
  }
}

// ---- Rounding ----------------------------------------------------

/**
 * Round half away from zero to `d` decimals, the way Postgres rounds
 * `x::numeric`. The double is first read at 15 significant digits,
 * which is what the float8 to numeric cast does, so 1.005 rounds to
 * 1.01 in both places. Returns the decimal text with exactly
 * max(d, 0) decimals.
 */
export function roundText(x: number, d: number): string {
  const neg = x < 0 || Object.is(x, -0);
  const p = Math.abs(x).toPrecision(15);
  // Digits and the decimal exponent of the first digit.
  let digits: string;
  let pointAt: number; // number of digits before the decimal point
  if (p.includes('e')) {
    const [m, e] = p.split('e') as [string, string];
    digits = m.replace('.', '');
    pointAt = Number(e) + 1;
  } else {
    const [i, f = ''] = p.split('.') as [string, string?];
    digits = i + f;
    pointAt = i.length;
  }
  // Pad so the rounding position exists on both sides.
  const keep = pointAt + d; // digits kept
  if (keep < 0) return d > 0 ? `0.${'0'.repeat(d)}` : '0';
  if (pointAt < 0) {
    digits = '0'.repeat(-pointAt) + digits;
    pointAt = 0;
  }
  const keepN = pointAt + d;
  digits = digits.padEnd(keepN + 1, '0');
  let kept = BigInt(digits.slice(0, keepN) || '0');
  if (Number(digits[keepN]) >= 5) kept += 1n;
  let s = kept.toString().padStart(Math.max(keepN, 1), '0');
  if (d > 0) {
    s = s.padStart(d + 1, '0');
    s = `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`;
  } else if (d < 0) {
    s = s + '0'.repeat(-d);
  }
  s = s.replace(/^0+(?=\d)/, '');
  const isZero = /^[0.]*$/.test(s);
  return neg && !isZero ? `-${s}` : s;
}

export function roundNum(x: number, d: number): number {
  return Number(roundText(x, d));
}

// ---- Text helpers (code points, like Postgres) -------------------

export const chars = (s: string): string[] => Array.from(s);

export function initcap(s: string): string {
  let out = '';
  let prevAlnum = false;
  for (const c of chars(s)) {
    const isAlnum = /[\p{L}\p{N}]/u.test(c);
    out += isAlnum ? (prevAlnum ? c.toLowerCase() : c.toUpperCase()) : c;
    prevAlnum = isAlnum;
  }
  return out;
}

export const TRIM_CHARS = ' \t\r\n';

export function trimChars(s: string, left: boolean, right: boolean): string {
  let a = 0;
  let b = s.length;
  if (left) while (a < b && TRIM_CHARS.includes(s[a]!)) a += 1;
  if (right) while (b > a && TRIM_CHARS.includes(s[b - 1]!)) b -= 1;
  return s.slice(a, b);
}

/** SQL LIKE as a RegExp. Backslash escapes the next character. */
export function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 1;
    } else if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'iu' : 'u');
}

/** split_part with Postgres's rules, including a negative index. */
export function splitPart(s: string, sep: string, n: number): string {
  if (n === 0) return '';
  const parts = sep === '' ? [s] : s.split(sep);
  const idx = n > 0 ? n - 1 : parts.length + n;
  return parts[idx] ?? '';
}

/** Group digits with commas: "1234567" to "1,234,567". */
export function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
