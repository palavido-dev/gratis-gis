// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gdal-async hands Date, DateTime and Time fields back from
 * `feature.fields.toObject()` as plain objects, not strings:
 *
 *   Date      { year, month, day }
 *   DateTime  { year, month, day, hour, minute, second, timezone? }
 *   Time      { hour, minute, second }
 *
 * The feature validator accepts a Date or a parseable string for a date
 * field, so these objects failed every row ("X is a date field but
 * received an object") and a shapefile, GeoPackage or GeoJSON with any
 * date column imported with no features. This module turns them into
 * strings before the rows leave the ingest service.
 *
 * GDAL's timezone flag: 0 unknown, 1 local time, 100 UTC, and every
 * step away from 100 is 15 minutes (96 is UTC-01:00, 88 is UTC-03:00).
 * Unknown and local time get no suffix; there is nothing better to say.
 */

type GdalDateish = {
  year?: unknown;
  month?: unknown;
  day?: unknown;
  hour?: unknown;
  minute?: unknown;
  second?: unknown;
  timezone?: unknown;
};

const pad = (n: number, w = 2): string => String(Math.trunc(Math.abs(n))).padStart(w, '0');

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function timePart(o: GdalDateish): string {
  const h = isInt(o.hour) ? o.hour : 0;
  const m = isInt(o.minute) ? o.minute : 0;
  const s = isInt(o.second) ? o.second : 0;
  const whole = Math.trunc(s);
  // .9995 and up rounds to 1000, which printed as ".1000" and read
  // back as .100. Clamp: the lost half millisecond does not matter.
  const ms = Math.min(999, Math.round((s - whole) * 1000));
  const frac = ms > 0 ? `.${pad(ms, 3)}` : '';
  return `${pad(h)}:${pad(m)}:${pad(whole)}${frac}`;
}

function tzSuffix(tz: unknown): string {
  if (!isInt(tz) || tz <= 1) return '';
  if (tz === 100) return 'Z';
  const minutes = (tz - 100) * 15;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function isDateish(v: unknown): v is GdalDateish {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) {
    return false;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  const allowed = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'timezone']);
  return keys.every((k) => allowed.has(k));
}

/**
 * One GDAL value to what the validator and the store expect. Anything
 * that is not a GDAL date-like object passes through untouched.
 */
export function normalizeGdalValue(v: unknown): unknown {
  // GDAL list fields (IntegerList, RealList, StringList) come back as
  // arrays. They are typed as text (see gdalTypeToSimple), and a text
  // field refuses a list, so the import stopped at the first row.
  // JSON keeps every element and its type.
  if (Array.isArray(v)) return JSON.stringify(v);
  if (!isDateish(v)) return v;
  const hasDate = isInt(v.year) && isInt(v.month) && isInt(v.day);
  if (hasDate) {
    const { year, month, day } = v as { year: number; month: number; day: number };
    // Shapefiles store an empty date as zeros; that is "no value".
    if (year <= 0 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
    const hasTime = isInt(v.hour) || isInt(v.minute) || isInt(v.second);
    return hasTime ? `${date}T${timePart(v)}${tzSuffix(v.timezone)}` : date;
  }
  if (isInt(v.hour)) return timePart(v);
  return null;
}

/** Every value in a feature's property bag, see normalizeGdalValue. */
export function normalizeGdalProps(raw: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(raw)) {
    const n = normalizeGdalValue(v);
    if (n !== v) {
      out ??= { ...raw };
      out[k] = n;
    }
  }
  return out ?? raw;
}

/**
 * GDAL field type name to the simple type the wizard and schema use.
 * A Time field (time of day, no date) is text: it is not a date we can
 * place on a calendar, and treating it as one failed every row.
 */
export function gdalTypeToSimple(t: string): 'string' | 'number' | 'boolean' | 'date' {
  const u = t.toLowerCase();
  // List types hold several values per row. gdal-async names them
  // `integer[]`, `real[]`, `string[]`; GDAL itself `IntegerList` etc.
  if (u.endsWith('[]') || u.endsWith('list')) return 'string';
  if (u.includes('int') || u.includes('real') || u.includes('double')) {
    return 'number';
  }
  if (u === 'time') return 'string';
  if (u.includes('date') || u.includes('time')) return 'date';
  if (u.includes('bool')) return 'boolean';
  return 'string';
}
