// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers for showing a bound form inside the field app.
 *
 * A form can name one of its questions as its location
 * (`geometryQuestionId`), so it also works on its own at
 * /forms/respond. In the field app the map supplies the point, line
 * or area, so that question is a second, required way to say the same
 * thing. Worse, its answer (an object) used to land in the feature's
 * properties next to the real geometry (#767, #769).
 */
import type { FormSchema, Question, Response } from '@gratis-gis/form-schema';

/**
 * The form without its location question, for the field app, where
 * the map supplies the geometry. Walks into groups. Returns the same
 * object when the form names no location question, so memoized
 * consumers keep their identity.
 */
export function withoutMapGeometryQuestion(form: FormSchema): FormSchema {
  const geometryId = form.geometryQuestionId;
  if (!geometryId) return form;
  function strip(qs: Question[]): Question[] {
    const out: Question[] = [];
    for (const q of qs) {
      if (q.id === geometryId) continue;
      out.push(q.type === 'group' ? { ...q, children: strip(q.children) } : q);
    }
    return out;
  }
  return { ...form, questions: strip(form.questions) };
}

/**
 * The response without the form's location answer. The geometry is
 * saved from the map, not as an attribute, so a stray value under
 * that key (from a row saved before #769) does not travel on.
 */
export function withoutMapGeometryAnswer(form: FormSchema, response: Response): Response {
  const geometryId = form.geometryQuestionId;
  if (!geometryId || !(geometryId in response)) return response;
  const { [geometryId]: _drop, ...rest } = response;
  void _drop;
  return rest;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A short label for a feature: the first non-empty user value. Skips
 * underscore-prefixed system keys, values that are objects or arrays
 * (a location or a list of photos would read as "[object Object]",
 * #767) and UUIDs (a related row's parent key is the same for every
 * row). Returns null when nothing fits, so the caller can fall back to
 * the row's id.
 */
export function pickRowTitle(properties: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (!s || UUID_RE.test(s)) continue;
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  }
  return null;
}
