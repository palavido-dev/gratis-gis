// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MapFilterOp, MapLayerFilter } from '@gratis-gis/shared-types';

const FILTER_OPS = new Set<MapFilterOp>([
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'is-null',
  'is-not-null',
]);

const FORM_FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'multi_select',
]);

export interface AiFormFieldDraft {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'multi_select';
}

export interface AiMapFilterDraft {
  layerTitle: string;
  filter: MapLayerFilter;
}

export interface AiLayerSummaryDraft {
  title: string;
  bullets: string[];
}

export interface AiDraft {
  summary: string;
  mapFilter: AiMapFilterDraft | null;
  layerSummary: AiLayerSummaryDraft | null;
  formFields: AiFormFieldDraft[];
}

export class UnusableDraftError extends Error {
  constructor() {
    super('The model did not return a usable draft.');
    this.name = 'UnusableDraftError';
  }
}

/**
 * Parse the model's text into the draft shape the portal renders.
 * Extra keys are dropped. A missing or empty summary is a failure;
 * a broken filter or field is dropped so one bad clause does not
 * throw away a usable summary.
 */
export function parseModelDraft(text: string): AiDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFence(text));
  } catch {
    throw new UnusableDraftError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnusableDraftError();
  }
  const root = parsed as Record<string, unknown>;
  const body =
    root.draft && typeof root.draft === 'object' && !Array.isArray(root.draft)
      ? (root.draft as Record<string, unknown>)
      : root;
  const summary = clip(body.summary, 2000);
  if (!summary) throw new UnusableDraftError();
  return {
    summary,
    mapFilter: parseMapFilter(body.mapFilter),
    layerSummary: parseLayerSummary(body.layerSummary),
    formFields: parseFormFields(body.formFields),
  };
}

function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function parseMapFilter(raw: unknown): AiMapFilterDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const layerTitle = clip(rec.layerTitle, 200);
  const filter = rec.filter;
  if (!layerTitle || !filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return null;
  }
  const filterRec = filter as Record<string, unknown>;
  const combinator = filterRec.combinator === 'any' ? 'any' : filterRec.combinator === 'all' ? 'all' : null;
  if (!combinator || !Array.isArray(filterRec.clauses)) return null;
  const clauses: MapLayerFilter['clauses'] = [];
  for (const clause of filterRec.clauses) {
    if (clauses.length >= 12) break;
    if (!clause || typeof clause !== 'object') continue;
    const row = clause as Record<string, unknown>;
    const field = clip(row.field, 80);
    const op = typeof row.op === 'string' && FILTER_OPS.has(row.op as MapFilterOp)
      ? (row.op as MapFilterOp)
      : null;
    if (!field || !op) continue;
    const value = op === 'is-null' || op === 'is-not-null' ? '' : clip(row.value, 200) ?? '';
    clauses.push({ field, op, value });
  }
  if (clauses.length === 0) return null;
  return { layerTitle, filter: { combinator, clauses } };
}

function parseLayerSummary(raw: unknown): AiLayerSummaryDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const title = clip(rec.title, 200);
  if (!title || !Array.isArray(rec.bullets)) return null;
  const bullets: string[] = [];
  for (const bullet of rec.bullets) {
    if (bullets.length >= 12) break;
    const text = clip(bullet, 300);
    if (text) bullets.push(text);
  }
  if (bullets.length === 0) return null;
  return { title, bullets };
}

function parseFormFields(raw: unknown): AiFormFieldDraft[] {
  if (!Array.isArray(raw)) return [];
  const fields: AiFormFieldDraft[] = [];
  for (const entry of raw) {
    if (fields.length >= 40) break;
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const name = clip(rec.name, 80);
    const label = clip(rec.label, 120);
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (!name || !label || !FORM_FIELD_TYPES.has(type)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    fields.push({
      name,
      label,
      type: type as AiFormFieldDraft['type'],
    });
  }
  return fields;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
