// SPDX-License-Identifier: AGPL-3.0-or-later
// Value handling for the Editor's attribute form.
//
// The form is seeded from three kinds of input: a stored row,
// properties read off a rendered map feature, and a template's
// presets, which the config page stores as text. Each needs turning
// into the value the input shows, or the form shows one thing and
// saves another (a "false" preset showed as a ticked box; a
// multi_select read back as JSON text ticked nothing).

import type { FeatureField } from '@gratis-gis/shared-types';

/**
 * Codes of a multi_select value. Accepts a real array, JSON array
 * text (how a map tile can hand an array property back), or legacy
 * comma separated text.
 */
export function coerceArrayCodes(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x));
  }
  if (typeof v === 'string') {
    const text = v.trim();
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return coerceArrayCodes(parsed);
      } catch {
        // Not JSON after all; fall through to the comma split.
      }
    }
    return text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [String(v)];
}

const TRUE_TEXT = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_TEXT = new Set(['false', 'no', 'n', '0', 'off', '']);

/**
 * The value a field's input starts from, typed for the field. A
 * missing value stays null for the caller to default. Text that does
 * not fit the field type becomes null rather than being shown as
 * something it is not.
 */
export function seedFieldValue(field: FeatureField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw !== 0;
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (TRUE_TEXT.has(t)) return true;
        if (FALSE_TEXT.has(t)) return false;
      }
      return null;
    }
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
      if (typeof raw === 'string') {
        if (raw.trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }
    case 'multi_select':
      return coerceArrayCodes(raw);
    default:
      return raw;
  }
}

/** True when a required field has no value, an empty pick counting as none. */
export function isMissingValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  );
}
