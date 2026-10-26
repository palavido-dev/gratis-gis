// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #160 Smart upload Phase 2: boundary-name geomatch.
 *
 * When a CSV has no coordinate pair (and is not an address file), look
 * for a column of US state names or abbreviations and join each row to
 * the vendored state polygon. Success criterion from the roadmap: a
 * "State" + "Population" spreadsheet becomes a state-polygon layer
 * without manual schema editing.
 *
 * Boundaries live at `apps/portal-api/content/boundaries/us-states.geojson`
 * (public-domain Cartographic Boundary / PublicaMundi-derived polygons
 * with `name` + `abbr` properties). Loaded once per process.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectCsvColumnPair,
  readDelimitedSample,
} from './csv-smart-detect.js';

export const GEOMATCH_LIMITS = {
  MAX_ROWS: 5_000,
  VALIDATION_SAMPLE_ROWS: 50,
  MIN_VALIDATION_RATIO: 0.6,
  MIN_NAME_SCORE: 70,
};

const STATE_COLUMN: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^state$/, score: 100 },
  { pattern: /^statename$/, score: 100 },
  { pattern: /^stateabbr$/, score: 95 },
  { pattern: /^statecode$/, score: 95 },
  { pattern: /^st$/, score: 80 },
  { pattern: /^province$/, score: 70 },
  { pattern: /^region$/, score: 55 },
];

export interface GeomatchPlan {
  kind: 'us-states';
  column: string;
  columnIndex: number;
  header: string[];
  rows: string[][];
  fields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
  }>;
}

export type GeomatchDetect =
  | GeomatchPlan
  | { kind: 'none'; reason: string };

export interface GeomatchResult {
  kind: 'matched';
  geojson: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      properties: Record<string, unknown>;
      geometry: GeoJsonGeometry;
    }>;
  };
  fields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
  }>;
  column: string;
  matched: number;
  unmatched: number;
}

type GeoJsonGeometry = {
  type: string;
  coordinates: unknown;
};

interface StateBoundary {
  name: string;
  abbr: string;
  geometry: GeoJsonGeometry;
}

let cachedStates: StateBoundary[] | null = null;
let cachedByKey: Map<string, StateBoundary> | null = null;

function boundariesPath(): string {
  // Dist: dist/ingest → ../../content/boundaries
  // Jest/src: src/ingest → ../../content/boundaries
  return join(__dirname, '..', '..', 'content', 'boundaries', 'us-states.geojson');
}

export function loadUsStateBoundaries(
  path = boundariesPath(),
): StateBoundary[] {
  if (cachedStates) return cachedStates;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    features: Array<{
      properties: { name: string; abbr: string };
      geometry: GeoJsonGeometry;
    }>;
  };
  cachedStates = raw.features.map((f) => ({
    name: f.properties.name,
    abbr: f.properties.abbr,
    geometry: f.geometry,
  }));
  cachedByKey = new Map();
  for (const s of cachedStates) {
    cachedByKey.set(normalizeKey(s.name), s);
    cachedByKey.set(normalizeKey(s.abbr), s);
  }
  return cachedStates;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function bestColumn(
  header: string[],
  vocab: Array<{ pattern: RegExp; score: number }>,
): { idx: number; score: number } | null {
  let best: { idx: number; score: number } | null = null;
  for (let i = 0; i < header.length; i += 1) {
    const normalized = (header[i] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    let score = 0;
    for (const v of vocab) {
      if (v.pattern.test(normalized) && v.score > score) score = v.score;
    }
    if (score >= GEOMATCH_LIMITS.MIN_NAME_SCORE) {
      if (!best || score > best.score) best = { idx: i, score };
    }
  }
  return best;
}

function inferFieldType(
  rows: string[][],
  idx: number,
): 'string' | 'number' | 'boolean' | 'date' {
  let numeric = 0;
  let seen = 0;
  for (const row of rows.slice(0, 40)) {
    const raw = (row[idx] ?? '').trim();
    if (!raw) continue;
    seen += 1;
    if (/^-?\d+(\.\d+)?$/.test(raw)) numeric += 1;
  }
  if (seen > 0 && numeric / seen >= 0.8) return 'number';
  return 'string';
}

/**
 * Detect a US-state name/abbr column. Skips files that already have
 * coordinates. Does not attempt address geocoding — callers decide
 * order (coords → geomatch → address).
 */
export function planUsStateGeomatch(text: string): GeomatchDetect {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (detectCsvColumnPair(clean).kind === 'detected') {
    return { kind: 'none', reason: 'File already has coordinates' };
  }
  const parsed = readDelimitedSample(clean, GEOMATCH_LIMITS.MAX_ROWS);
  if ('error' in parsed) return { kind: 'none', reason: parsed.error };

  const { header, rows } = parsed;
  const col = bestColumn(header, STATE_COLUMN);
  if (!col) {
    return { kind: 'none', reason: 'No state / province column name detected' };
  }

  loadUsStateBoundaries();
  const sample = rows.slice(0, GEOMATCH_LIMITS.VALIDATION_SAMPLE_ROWS);
  let hit = 0;
  let seen = 0;
  for (const row of sample) {
    const raw = (row[col.idx] ?? '').trim();
    if (!raw) continue;
    seen += 1;
    if (cachedByKey!.has(normalizeKey(raw))) hit += 1;
  }
  if (seen === 0) {
    return { kind: 'none', reason: 'State column has no values to validate' };
  }
  const ratio = hit / seen;
  if (ratio < GEOMATCH_LIMITS.MIN_VALIDATION_RATIO) {
    return {
      kind: 'none',
      reason: `State column values matched ${Math.round(ratio * 100)}% (need ${Math.round(GEOMATCH_LIMITS.MIN_VALIDATION_RATIO * 100)}%)`,
    };
  }

  const fields = header.map((name, idx) => ({
    name,
    type: inferFieldType(rows, idx),
  }));

  return {
    kind: 'us-states',
    column: header[col.idx]!,
    columnIndex: col.idx,
    header,
    rows,
    fields,
  };
}

/** Join planned rows to state polygons. Unmatched rows are dropped. */
export function featuresFromUsStateGeomatch(
  plan: GeomatchPlan,
): GeomatchResult {
  loadUsStateBoundaries();
  const features: GeomatchResult['geojson']['features'] = [];
  let unmatched = 0;
  for (const row of plan.rows) {
    const raw = (row[plan.columnIndex] ?? '').trim();
    const state = raw ? cachedByKey!.get(normalizeKey(raw)) : undefined;
    if (!state) {
      unmatched += 1;
      continue;
    }
    // Build via Map + fromEntries so we never assign `obj[userKey] = …`
    // (CodeQL js/remote-property-injection). Deny dangerous names, then
    // materialize a null-prototype record for GeoJSON consumers.
    const entries = new Map<string, unknown>();
    for (let i = 0; i < plan.header.length; i += 1) {
      const name = safePropertyName(plan.header[i]!);
      if (name === null) continue;
      const field = plan.fields[i];
      const cell = (row[i] ?? '').trim();
      if (field?.type === 'number' && cell !== '' && /^-?\d+(\.\d+)?$/.test(cell)) {
        entries.set(name, Number(cell));
      } else {
        entries.set(name, cell);
      }
    }
    entries.set('state_name', state.name);
    entries.set('state_abbr', state.abbr);
    // fromEntries avoids the `obj[taintedKey]=` sink; dangerous names
    // were already dropped by safePropertyName.
    const properties = Object.fromEntries(entries) as Record<string, unknown>;
    features.push({
      type: 'Feature',
      properties,
      geometry: state.geometry,
    });
  }
  return {
    kind: 'matched',
    geojson: { type: 'FeatureCollection', features },
    fields: [
      ...plan.fields,
      { name: 'state_name', type: 'string' },
      { name: 'state_abbr', type: 'string' },
    ],
    column: plan.column,
    matched: features.length,
    unmatched,
  };
}

/**
 * Reject header names that would be dangerous as object keys
 * (`__proto__`, `constructor`, `prototype`) or empty after trim.
 */
function safePropertyName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  if (
    lower === '__proto__' ||
    lower === 'constructor' ||
    lower === 'prototype'
  ) {
    return null;
  }
  return name;
}

/** Detect + join in one call for the buffer ingest path. */
export function detectUsStateGeomatch(text: string): GeomatchResult | { kind: 'none'; reason: string } {
  const plan = planUsStateGeomatch(text);
  if (plan.kind === 'none') return plan;
  const built = featuresFromUsStateGeomatch(plan);
  if (built.matched === 0) {
    return { kind: 'none', reason: 'No rows matched a US state name or abbreviation' };
  }
  return built;
}
