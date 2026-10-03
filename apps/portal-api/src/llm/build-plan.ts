// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The model proposes a plan. This module is the only thing that
 * turns that text into items: unknown keys are dropped, ids the
 * caller cannot see are refused, and every string is bounded.
 * The service then creates from the parsed plan, never from the
 * raw model text.
 */

export type LayerGeometry = 'point' | 'line' | 'polygon';

export interface CatalogLayer {
  id: string;
  title: string;
  layerKey: string;
  geometry: LayerGeometry;
  fields: string[];
}

export interface BuildField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date';
}

export interface BuildLayer {
  ref: string;
  title: string;
  geometry: LayerGeometry;
  fields: BuildField[];
  /** Set when the plan reuses a catalog layer instead of creating one. */
  reuse: { itemId: string; layerKey: string } | null;
}

export interface BuildMapLayer {
  ref: string;
  color: string;
}

export interface BuildMap {
  title: string;
  center: [number, number];
  zoom: number;
  layers: BuildMapLayer[];
}

export type BuildQuestionType =
  | 'text'
  | 'multiline'
  | 'number'
  | 'integer'
  | 'date'
  | 'email'
  | 'geopoint'
  | 'select-one';

export interface BuildQuestion {
  id: string;
  type: BuildQuestionType;
  label: string;
  required: boolean;
  choices: Array<{ value: string; label: string }>;
}

export interface BuildForm {
  title: string;
  /** Ref of a layer in this plan. Null means the form gets its own submissions layer. */
  layerRef: string | null;
  questions: BuildQuestion[];
}

export interface BuildApp {
  title: string;
}

export interface BuildPlan {
  summary: string;
  layers: BuildLayer[];
  map: BuildMap | null;
  form: BuildForm | null;
  app: BuildApp | null;
}

export class UnusablePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusablePlanError';
  }
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const QUESTION_TYPES = new Set<BuildQuestionType>([
  'text',
  'multiline',
  'number',
  'integer',
  'date',
  'email',
  'geopoint',
  'select-one',
]);
const FIELD_TYPES = new Set<BuildField['type']>([
  'string',
  'number',
  'boolean',
  'date',
]);
const GEOMETRIES = new Set<LayerGeometry>(['point', 'line', 'polygon']);
const COLORS = ['#21466e', '#c2410c', '#0f766e', '#7c3aed', '#b45309'];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function slug(value: string, fallback: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!out || !/^[a-z]/.test(out)) return fallback;
  return out;
}

/** Pull a JSON object out of a chat reply, including a fenced block. */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new UnusablePlanError('The model did not return a plan.');
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new UnusablePlanError('The model plan was not valid JSON.');
  }
}

export function parseBuildPlan(raw: string, catalog: CatalogLayer[]): BuildPlan {
  const root = asRecord(extractJsonObject(raw));
  if (!root) throw new UnusablePlanError('The model plan was not an object.');

  const catalogById = new Map(catalog.map((layer) => [layer.id, layer]));
  const layers: BuildLayer[] = [];
  const seenRefs = new Set<string>();
  const rawLayers = Array.isArray(root.layers) ? root.layers.slice(0, 4) : [];

  for (const entry of rawLayers) {
    const row = asRecord(entry);
    if (!row) continue;
    const title = text(row.title, 120);
    const ref = slug(text(row.ref, 40) || title, `layer_${layers.length + 1}`);
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const reuseId = text(row.reuseItemId, 80);
    const known = reuseId ? catalogById.get(reuseId) : undefined;
    if (reuseId && !known) {
      throw new UnusablePlanError('The plan named a layer this account cannot use.');
    }
    if (known) {
      layers.push({
        ref,
        title: title || known.title,
        geometry: known.geometry,
        fields: [],
        reuse: { itemId: known.id, layerKey: known.layerKey },
      });
      continue;
    }

    const geometry = text(row.geometry, 16);
    if (!GEOMETRIES.has(geometry as LayerGeometry)) continue;
    const fields: BuildField[] = [];
    const seenFields = new Set<string>();
    const rawFields = Array.isArray(row.fields) ? row.fields.slice(0, 12) : [];
    for (const field of rawFields) {
      const f = asRecord(field);
      if (!f) continue;
      const label = text(f.label, 80);
      const name = slug(text(f.name, 40) || label, '');
      const type = text(f.type, 16);
      if (!name || !FIELD_NAME.test(name) || seenFields.has(name)) continue;
      if (!FIELD_TYPES.has(type as BuildField['type'])) continue;
      seenFields.add(name);
      fields.push({ name, label: label || name, type: type as BuildField['type'] });
    }
    if (!title) continue;
    layers.push({
      ref,
      title,
      geometry: geometry as LayerGeometry,
      fields,
      reuse: null,
    });
  }

  const layerRefs = new Set(layers.map((layer) => layer.ref));
  let map: BuildMap | null = null;
  const rawMap = asRecord(root.map);
  if (rawMap) {
    const title = text(rawMap.title, 120);
    const mapLayers: BuildMapLayer[] = [];
    const rawMapLayers = Array.isArray(rawMap.layers) ? rawMap.layers.slice(0, 4) : [];
    for (const entry of rawMapLayers) {
      const row = asRecord(entry);
      if (!row) continue;
      const ref = text(row.ref, 40);
      if (!layerRefs.has(ref)) continue;
      const color = text(row.color, 7);
      mapLayers.push({
        ref,
        color: HEX.test(color) ? color : COLORS[mapLayers.length % COLORS.length]!,
      });
    }
    if (mapLayers.length === 0) {
      for (const layer of layers) {
        mapLayers.push({
          ref: layer.ref,
          color: COLORS[mapLayers.length % COLORS.length]!,
        });
      }
    }
    const center = readCenter(rawMap.center);
    const zoomRaw = typeof rawMap.zoom === 'number' ? rawMap.zoom : 10;
    if (title && mapLayers.length > 0) {
      map = {
        title,
        center,
        zoom: Math.min(18, Math.max(1, Math.round(zoomRaw))),
        layers: mapLayers,
      };
    }
  }

  let form: BuildForm | null = null;
  const rawForm = asRecord(root.form);
  if (rawForm) {
    const title = text(rawForm.title, 120);
    const layerRefRaw = text(rawForm.layerRef, 40);
    const layerRef = layerRefs.has(layerRefRaw) ? layerRefRaw : null;
    const questions: BuildQuestion[] = [];
    const seenQ = new Set<string>();
    const rawQuestions = Array.isArray(rawForm.questions)
      ? rawForm.questions.slice(0, 12)
      : [];
    for (const entry of rawQuestions) {
      const row = asRecord(entry);
      if (!row) continue;
      const label = text(row.label, 120);
      const type = text(row.type, 20);
      if (!label || !QUESTION_TYPES.has(type as BuildQuestionType)) continue;
      const id = slug(text(row.id, 40) || label, `q_${questions.length + 1}`);
      if (seenQ.has(id)) continue;
      seenQ.add(id);
      const choices: Array<{ value: string; label: string }> = [];
      if (type === 'select-one' && Array.isArray(row.choices)) {
        for (const choice of row.choices.slice(0, 12)) {
          const c = asRecord(choice);
          if (!c) continue;
          const choiceLabel = text(c.label, 80);
          const value = slug(text(c.value, 40) || choiceLabel, '');
          if (!choiceLabel || !value) continue;
          choices.push({ value, label: choiceLabel });
        }
      }
      if (type === 'select-one' && choices.length === 0) continue;
      questions.push({
        id,
        type: type as BuildQuestionType,
        label,
        required: row.required === true,
        choices,
      });
    }
    if (title && questions.length > 0) {
      form = { title, layerRef, questions };
    }
  }

  let app: BuildApp | null = null;
  const rawApp = asRecord(root.app);
  if (rawApp && map) {
    const title = text(rawApp.title, 120);
    if (title) app = { title };
  }

  if (layers.length === 0 && !form) {
    throw new UnusablePlanError(
      'The plan did not include a layer or a form to create.',
    );
  }

  return {
    summary: text(root.summary, 400) || 'Build from your description.',
    layers,
    map,
    form,
    app,
  };
}

function readCenter(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [-98.5795, 39.8283];
  const lng = value[0];
  const lat = value[1];
  if (typeof lng !== 'number' || typeof lat !== 'number') return [-98.5795, 39.8283];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [-98.5795, 39.8283];
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return [-98.5795, 39.8283];
  return [lng, lat];
}
