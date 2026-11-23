// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Date arithmetic for the JavaScript evaluator. All of it works in
 * UTC; the SQL twins convert with `AT TIME ZONE 'UTC'` so a server
 * time zone never leaks in. `today()` is the one function that reads
 * a time zone, and it takes it from the evaluation context.
 */

import { DAY_MS, daysInMonth, utcMs } from './values';

export type DateUnit =
  | 'years'
  | 'quarters'
  | 'months'
  | 'weeks'
  | 'days'
  | 'hours'
  | 'minutes'
  | 'seconds';

const UNIT_ALIASES: Record<string, DateUnit> = {
  year: 'years',
  years: 'years',
  y: 'years',
  quarter: 'quarters',
  quarters: 'quarters',
  month: 'months',
  months: 'months',
  week: 'weeks',
  weeks: 'weeks',
  day: 'days',
  days: 'days',
  d: 'days',
  hour: 'hours',
  hours: 'hours',
  h: 'hours',
  minute: 'minutes',
  minutes: 'minutes',
  second: 'seconds',
  seconds: 'seconds',
  s: 'seconds',
};

export function dateUnit(text: string): DateUnit | null {
  return UNIT_ALIASES[text.trim().toLowerCase()] ?? null;
}

export const FIXED_UNIT_MS: Partial<Record<DateUnit, number>> = {
  weeks: 7 * DAY_MS,
  days: DAY_MS,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1000,
};

export function parts(ms: number) {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
    /** ISO weekday, Monday 1 to Sunday 7. */
    dow: ((d.getUTCDay() + 6) % 7) + 1,
  };
}

function addMonths(ms: number, n: number): number {
  const p = parts(ms);
  const total = p.y * 12 + (p.mo - 1) + n;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const day = Math.min(p.d, daysInMonth(y, mo));
  return utcMs(y, mo, day, p.h, p.mi, p.s, p.ms);
}

/** `date_add`: months and years take whole numbers (truncated). */
export function addUnits(ms: number, n: number, unit: DateUnit): number {
  const fixed = FIXED_UNIT_MS[unit];
  if (fixed !== undefined) return ms + n * fixed;
  const whole = Math.trunc(n);
  if (unit === 'months') return addMonths(ms, whole);
  if (unit === 'quarters') return addMonths(ms, whole * 3);
  return addMonths(ms, whole * 12);
}

/**
 * Whole calendar months from b to a, counting a month only once it
 * has fully passed (age() semantics, without its sign quirks).
 * Mirrored by gg_expr_month_diff.
 */
export function monthDiff(a: number, b: number): number {
  const pa = parts(a);
  const pb = parts(b);
  let m = pa.y * 12 + pa.mo - (pb.y * 12 + pb.mo);
  const ta = ((pa.d * 24 + pa.h) * 60 + pa.mi) * 60_000 + pa.s * 1000 + pa.ms;
  const tb = ((pb.d * 24 + pb.h) * 60 + pb.mi) * 60_000 + pb.s * 1000 + pb.ms;
  if (m > 0 && ta < tb) m -= 1;
  else if (m < 0 && ta > tb) m += 1;
  return m;
}

/** `date_diff(a, b, unit)`: a minus b. */
export function diffUnits(a: number, b: number, unit: DateUnit): number {
  const fixed = FIXED_UNIT_MS[unit];
  if (fixed !== undefined) return (a - b) / fixed;
  const m = monthDiff(a, b);
  if (unit === 'months') return m;
  if (unit === 'quarters') return Math.trunc(m / 3);
  return Math.trunc(m / 12);
}

export type DatePart =
  | 'year'
  | 'quarter'
  | 'month'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second'
  | 'weekday'
  | 'day_of_year'
  | 'week';

export function isoWeek(ms: number): number {
  const p = parts(ms);
  // Thursday of this week decides the ISO year.
  const thursday = utcMs(p.y, p.mo, p.d) + (4 - p.dow) * DAY_MS;
  const ty = new Date(thursday).getUTCFullYear();
  const jan1 = utcMs(ty, 1, 1);
  return Math.floor((thursday - jan1) / DAY_MS / 7) + 1;
}

export function datePart(ms: number, part: DatePart): number {
  const p = parts(ms);
  switch (part) {
    case 'year':
      return p.y;
    case 'quarter':
      return Math.floor((p.mo - 1) / 3) + 1;
    case 'month':
      return p.mo;
    case 'day':
      return p.d;
    case 'hour':
      return p.h;
    case 'minute':
      return p.mi;
    case 'second':
      return p.s;
    case 'weekday':
      return p.dow;
    case 'day_of_year':
      return Math.floor((utcMs(p.y, p.mo, p.d) - utcMs(p.y, 1, 1)) / DAY_MS) + 1;
    case 'week':
      return isoWeek(ms);
  }
}

/** `start_of(date, unit)`: weeks start on Monday. */
export function startOf(ms: number, unit: DateUnit): number {
  const p = parts(ms);
  switch (unit) {
    case 'years':
      return utcMs(p.y, 1, 1);
    case 'quarters':
      return utcMs(p.y, Math.floor((p.mo - 1) / 3) * 3 + 1, 1);
    case 'months':
      return utcMs(p.y, p.mo, 1);
    case 'weeks':
      return utcMs(p.y, p.mo, p.d) - (p.dow - 1) * DAY_MS;
    case 'days':
      return utcMs(p.y, p.mo, p.d);
    case 'hours':
      return utcMs(p.y, p.mo, p.d, p.h);
    case 'minutes':
      return utcMs(p.y, p.mo, p.d, p.h, p.mi);
    case 'seconds':
      return utcMs(p.y, p.mo, p.d, p.h, p.mi, p.s);
  }
}

/** Today's date in `timeZone`, as UTC midnight of that calendar day. */
export function todayIn(timeZone: string, nowMs: number): number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const bits = Object.fromEntries(
    f.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]),
  );
  return utcMs(Number(bits.year), Number(bits.month), Number(bits.day));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- format_date -------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Tokens, longest first so `MMMM` wins over `MM`. */
export const FORMAT_TOKENS = [
  'YYYY',
  'YY',
  'MMMM',
  'MMM',
  'MM',
  'M',
  'dddd',
  'ddd',
  'DD',
  'D',
  'HH',
  'H',
  'hh',
  'h',
  'mm',
  'ss',
  'A',
] as const;
export type FormatToken = (typeof FORMAT_TOKENS)[number];

export type FormatPiece = { token: FormatToken } | { text: string };

/**
 * Split a format pattern into tokens and literal text. Text inside
 * square brackets is always literal: `[Week of] MMM D`.
 */
export function parseFormat(pattern: string): FormatPiece[] {
  const out: FormatPiece[] = [];
  let text = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i) {
        text += pattern.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    const tok = FORMAT_TOKENS.find((t) => pattern.startsWith(t, i));
    if (tok) {
      if (text) out.push({ text });
      text = '';
      out.push({ token: tok });
      i += tok.length;
    } else {
      text += pattern[i];
      i += 1;
    }
  }
  if (text) out.push({ text });
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatDate(ms: number, pieces: FormatPiece[]): string {
  const p = parts(ms);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return pieces
    .map((piece) => {
      if ('text' in piece) return piece.text;
      switch (piece.token) {
        case 'YYYY':
          return String(p.y).padStart(4, '0');
        case 'YY':
          return pad2(p.y % 100);
        case 'MMMM':
          return MONTHS[p.mo - 1]!;
        case 'MMM':
          return MONTHS[p.mo - 1]!.slice(0, 3);
        case 'MM':
          return pad2(p.mo);
        case 'M':
          return String(p.mo);
        case 'dddd':
          return DAYS[p.dow - 1]!;
        case 'ddd':
          return DAYS[p.dow - 1]!.slice(0, 3);
        case 'DD':
          return pad2(p.d);
        case 'D':
          return String(p.d);
        case 'HH':
          return pad2(p.h);
        case 'H':
          return String(p.h);
        case 'hh':
          return pad2(h12);
        case 'h':
          return String(h12);
        case 'mm':
          return pad2(p.mi);
        case 'ss':
          return pad2(p.s);
        case 'A':
          return p.h < 12 ? 'AM' : 'PM';
      }
    })
    .join('');
}
