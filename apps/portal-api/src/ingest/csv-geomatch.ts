// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #160 Smart upload Phase 2: boundary-name geomatch.
 *
 * When a CSV has no coordinate pair, look for a boundary-name column
 * and join each row to a vendored polygon set. Order of preference:
 * US counties → US ZCTAs → countries → US states. Success criteria
 * from the roadmap: "State"+"Population" → state polygons; county
 * (+ optional state) → county polygons; ZIP/ZCTA → ZCTA polygons;
 * "Country"/"ISO" → country polygons.
 *
 * Boundaries live at `apps/portal-api/content/boundaries/`:
 * - `us-states.geojson` — name + abbr (PublicaMundi / CB lineage)
 * - `us-counties.geojson` — name + state_abbr + state_name + geoid
 *   (Census Cartographic Boundary 2023 20m; public domain)
 * - `us-zctas.geojson` — zcta (Census CB 2020 ZCTA5 500k, simplified;
 *   public domain)
 * - `countries.geojson` — name + iso2 + iso3 (+ aliases)
 *   (Natural Earth 110m admin-0; public domain)
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

const COUNTY_COLUMN: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^county$/, score: 100 },
  { pattern: /^countyname$/, score: 100 },
  { pattern: /^county_name$/, score: 100 },
  { pattern: /^cnty$/, score: 90 },
  { pattern: /^parish$/, score: 90 },
  { pattern: /^borough$/, score: 85 },
  { pattern: /^fips$/, score: 80 },
  { pattern: /^geoid$/, score: 80 },
];

const ZCTA_COLUMN: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^zcta$/, score: 100 },
  { pattern: /^zcta5$/, score: 100 },
  { pattern: /^zip$/, score: 100 },
  { pattern: /^zipcode$/, score: 100 },
  { pattern: /^zip_code$/, score: 100 },
  { pattern: /^postalcode$/, score: 90 },
  { pattern: /^postal$/, score: 85 },
  { pattern: /^postcode$/, score: 85 },
];

const COUNTRY_COLUMN: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^country$/, score: 100 },
  { pattern: /^countryname$/, score: 100 },
  { pattern: /^nation$/, score: 95 },
  { pattern: /^countrycode$/, score: 95 },
  { pattern: /^countryiso$/, score: 95 },
  { pattern: /^iso2$/, score: 90 },
  { pattern: /^iso3$/, score: 90 },
  { pattern: /^iso$/, score: 85 },
  { pattern: /^cc$/, score: 75 },
];

type FieldDef = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
};

interface GeomatchPlanBase {
  column: string;
  columnIndex: number;
  header: string[];
  rows: string[][];
  fields: FieldDef[];
}

export interface UsStateGeomatchPlan extends GeomatchPlanBase {
  kind: 'us-states';
}

export interface UsCountyGeomatchPlan extends GeomatchPlanBase {
  kind: 'us-counties';
  /** Optional companion state column for disambiguation. */
  stateColumnIndex: number | null;
}

export interface CountryGeomatchPlan extends GeomatchPlanBase {
  kind: 'countries';
}

export interface UsZctaGeomatchPlan extends GeomatchPlanBase {
  kind: 'us-zctas';
}

export type GeomatchPlan =
  | UsStateGeomatchPlan
  | UsCountyGeomatchPlan
  | UsZctaGeomatchPlan
  | CountryGeomatchPlan;

export type GeomatchDetect =
  | GeomatchPlan
  | { kind: 'none'; reason: string };

export interface GeomatchResult {
  kind: 'matched';
  boundary: 'us-states' | 'us-counties' | 'us-zctas' | 'countries';
  geojson: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      properties: Record<string, unknown>;
      geometry: GeoJsonGeometry;
    }>;
  };
  fields: FieldDef[];
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

interface CountyBoundary {
  name: string;
  stateAbbr: string;
  stateName: string;
  geoid: string;
  geometry: GeoJsonGeometry;
}

interface CountryBoundary {
  name: string;
  iso2: string;
  iso3: string;
  geometry: GeoJsonGeometry;
}

interface ZctaBoundary {
  zcta: string;
  geometry: GeoJsonGeometry;
}

let cachedStates: StateBoundary[] | null = null;
let cachedStateByKey: Map<string, StateBoundary> | null = null;

let cachedCounties: CountyBoundary[] | null = null;
/** `normalize(name)|normalize(abbr)` → county */
let cachedCountyByQualified: Map<string, CountyBoundary> | null = null;
/** Unique nationwide county names (and geoids) only */
let cachedCountyByUnique: Map<string, CountyBoundary> | null = null;

let cachedCountries: CountryBoundary[] | null = null;
let cachedCountryByKey: Map<string, CountryBoundary> | null = null;

let cachedZctas: ZctaBoundary[] | null = null;
let cachedZctaByKey: Map<string, ZctaBoundary> | null = null;

function boundariesDir(): string {
  // Dist: dist/ingest → ../../content/boundaries
  // Jest/src: src/ingest → ../../content/boundaries
  return join(__dirname, '..', '..', 'content', 'boundaries');
}

export function loadUsStateBoundaries(
  path = join(boundariesDir(), 'us-states.geojson'),
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
  cachedStateByKey = new Map();
  for (const s of cachedStates) {
    cachedStateByKey.set(normalizeKey(s.name), s);
    cachedStateByKey.set(normalizeKey(s.abbr), s);
  }
  return cachedStates;
}

export function loadUsCountyBoundaries(
  path = join(boundariesDir(), 'us-counties.geojson'),
): CountyBoundary[] {
  if (cachedCounties) return cachedCounties;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    features: Array<{
      properties: {
        name: string;
        state_abbr: string;
        state_name: string;
        geoid: string;
      };
      geometry: GeoJsonGeometry;
    }>;
  };
  cachedCounties = raw.features.map((f) => ({
    name: f.properties.name,
    stateAbbr: f.properties.state_abbr,
    stateName: f.properties.state_name,
    geoid: f.properties.geoid,
    geometry: f.geometry,
  }));
  cachedCountyByQualified = new Map();
  const nameCounts = new Map<string, number>();
  for (const c of cachedCounties) {
    const bare = normalizeCountyName(c.name);
    cachedCountyByQualified.set(`${bare}|${normalizeKey(c.stateAbbr)}`, c);
    cachedCountyByQualified.set(`${bare}|${normalizeKey(c.stateName)}`, c);
    cachedCountyByQualified.set(normalizeKey(c.geoid), c);
    nameCounts.set(bare, (nameCounts.get(bare) ?? 0) + 1);
  }
  cachedCountyByUnique = new Map();
  for (const c of cachedCounties) {
    const bare = normalizeCountyName(c.name);
    if ((nameCounts.get(bare) ?? 0) === 1) {
      cachedCountyByUnique.set(bare, c);
    }
    cachedCountyByUnique.set(normalizeKey(c.geoid), c);
  }
  return cachedCounties;
}

export function loadCountryBoundaries(
  path = join(boundariesDir(), 'countries.geojson'),
): CountryBoundary[] {
  if (cachedCountries) return cachedCountries;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    features: Array<{
      properties: {
        name: string;
        iso2: string;
        iso3: string;
        aliases?: string[];
      };
      geometry: GeoJsonGeometry;
    }>;
  };
  cachedCountries = raw.features.map((f) => ({
    name: f.properties.name,
    iso2: f.properties.iso2,
    iso3: f.properties.iso3,
    geometry: f.geometry,
  }));
  cachedCountryByKey = new Map();
  for (let i = 0; i < cachedCountries.length; i += 1) {
    const c = cachedCountries[i]!;
    const aliases = raw.features[i]?.properties.aliases ?? [];
    cachedCountryByKey.set(normalizeKey(c.name), c);
    if (c.iso2) cachedCountryByKey.set(normalizeKey(c.iso2), c);
    if (c.iso3) cachedCountryByKey.set(normalizeKey(c.iso3), c);
    for (const alias of aliases) {
      cachedCountryByKey.set(normalizeKey(alias), c);
    }
  }
  return cachedCountries;
}

export function loadUsZctaBoundaries(
  path = join(boundariesDir(), 'us-zctas.geojson'),
): ZctaBoundary[] {
  if (cachedZctas) return cachedZctas;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    features: Array<{
      properties: { zcta: string };
      geometry: GeoJsonGeometry;
    }>;
  };
  cachedZctas = raw.features.map((f) => ({
    zcta: f.properties.zcta,
    geometry: f.geometry,
  }));
  cachedZctaByKey = new Map();
  for (const z of cachedZctas) {
    cachedZctaByKey.set(normalizeZcta(z.zcta), z);
  }
  return cachedZctas;
}

/** Normalize ZIP / ZCTA cells to a 5-digit key (strips ZIP+4). */
function normalizeZcta(value: string): string {
  const digits = value.trim().replace(/\D/g, '');
  if (digits.length >= 5) return digits.slice(0, 5);
  return digits;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Strip trailing County/Parish/Borough so "Travis County" ≡ "Travis". */
function normalizeCountyName(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\s+(county|parish|borough|census area|municipality|city and borough)$/i, '');
  return normalizeKey(trimmed);
}

function bestColumn(
  header: string[],
  vocab: Array<{ pattern: RegExp; score: number }>,
  excludeIdx?: number,
): { idx: number; score: number } | null {
  let best: { idx: number; score: number } | null = null;
  for (let i = 0; i < header.length; i += 1) {
    if (i === excludeIdx) continue;
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

function parseCountyCell(raw: string): { name: string; state: string | null } {
  // "Travis, TX" / "Travis County, Texas"
  const comma = raw.match(/^(.+?)\s*,\s*([A-Za-z .]+)$/);
  if (comma) {
    return { name: comma[1]!.trim(), state: comma[2]!.trim() };
  }
  return { name: raw, state: null };
}

function lookupCounty(
  raw: string,
  stateHint: string | null,
): CountyBoundary | undefined {
  loadUsCountyBoundaries();
  const parsed = parseCountyCell(raw);
  const state = stateHint ?? parsed.state;
  const bare = normalizeCountyName(parsed.name);
  if (!bare) return undefined;

  // 5-digit GEOID shortcut
  if (/^\d{5}$/.test(raw.trim())) {
    return cachedCountyByQualified!.get(normalizeKey(raw));
  }

  if (state) {
    const hit = cachedCountyByQualified!.get(`${bare}|${normalizeKey(state)}`);
    if (hit) return hit;
  }
  return cachedCountyByUnique!.get(bare);
}

function rowProperties(
  plan: GeomatchPlanBase,
  row: string[],
  extras: Array<[string, unknown]>,
): Record<string, unknown> {
  // Build via Map + fromEntries so we never assign `obj[userKey] = …`
  // (CodeQL js/remote-property-injection).
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
  for (const [k, v] of extras) entries.set(k, v);
  return Object.fromEntries(entries) as Record<string, unknown>;
}

/**
 * Prefer counties → countries → states when the matching column
 * validates. Callers still own coords → geomatch → address ordering.
 */
export function planUsGeomatch(text: string): GeomatchDetect {
  const county = planUsCountyGeomatch(text);
  if (county.kind !== 'none') return county;
  const zcta = planUsZctaGeomatch(text);
  if (zcta.kind !== 'none') return zcta;
  const country = planCountryGeomatch(text);
  if (country.kind !== 'none') return country;
  return planUsStateGeomatch(text);
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
  // Dedicated County/Country columns mean state-only geomatch should
  // defer — planUsGeomatch already prefers those planners.
  if (bestColumn(header, COUNTY_COLUMN)) {
    return { kind: 'none', reason: 'County column present; defer to county geomatch' };
  }
  if (bestColumn(header, ZCTA_COLUMN)) {
    return { kind: 'none', reason: 'ZIP / ZCTA column present; defer to ZCTA geomatch' };
  }
  if (bestColumn(header, COUNTRY_COLUMN)) {
    return { kind: 'none', reason: 'Country column present; defer to country geomatch' };
  }
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
    if (cachedStateByKey!.has(normalizeKey(raw))) hit += 1;
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

export function planUsCountyGeomatch(text: string): GeomatchDetect {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (detectCsvColumnPair(clean).kind === 'detected') {
    return { kind: 'none', reason: 'File already has coordinates' };
  }
  const parsed = readDelimitedSample(clean, GEOMATCH_LIMITS.MAX_ROWS);
  if ('error' in parsed) return { kind: 'none', reason: parsed.error };

  const { header, rows } = parsed;
  const col = bestColumn(header, COUNTY_COLUMN);
  if (!col) {
    return { kind: 'none', reason: 'No county / parish column name detected' };
  }
  const stateCol = bestColumn(header, STATE_COLUMN, col.idx);

  loadUsCountyBoundaries();
  const sample = rows.slice(0, GEOMATCH_LIMITS.VALIDATION_SAMPLE_ROWS);
  let hit = 0;
  let seen = 0;
  for (const row of sample) {
    const raw = (row[col.idx] ?? '').trim();
    if (!raw) continue;
    seen += 1;
    const stateHint = stateCol ? (row[stateCol.idx] ?? '').trim() || null : null;
    if (lookupCounty(raw, stateHint)) hit += 1;
  }
  if (seen === 0) {
    return { kind: 'none', reason: 'County column has no values to validate' };
  }
  const ratio = hit / seen;
  if (ratio < GEOMATCH_LIMITS.MIN_VALIDATION_RATIO) {
    return {
      kind: 'none',
      reason: `County column values matched ${Math.round(ratio * 100)}% (need ${Math.round(GEOMATCH_LIMITS.MIN_VALIDATION_RATIO * 100)}%)`,
    };
  }

  const fields = header.map((name, idx) => ({
    name,
    type: inferFieldType(rows, idx),
  }));

  return {
    kind: 'us-counties',
    column: header[col.idx]!,
    columnIndex: col.idx,
    stateColumnIndex: stateCol ? stateCol.idx : null,
    header,
    rows,
    fields,
  };
}

export function planUsZctaGeomatch(text: string): GeomatchDetect {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (detectCsvColumnPair(clean).kind === 'detected') {
    return { kind: 'none', reason: 'File already has coordinates' };
  }
  const parsed = readDelimitedSample(clean, GEOMATCH_LIMITS.MAX_ROWS);
  if ('error' in parsed) return { kind: 'none', reason: parsed.error };

  const { header, rows } = parsed;
  if (bestColumn(header, COUNTY_COLUMN)) {
    return { kind: 'none', reason: 'County column present; defer to county geomatch' };
  }
  const col = bestColumn(header, ZCTA_COLUMN);
  if (!col) {
    return { kind: 'none', reason: 'No ZIP / ZCTA column name detected' };
  }

  loadUsZctaBoundaries();
  const sample = rows.slice(0, GEOMATCH_LIMITS.VALIDATION_SAMPLE_ROWS);
  let hit = 0;
  let seen = 0;
  for (const row of sample) {
    const raw = (row[col.idx] ?? '').trim();
    if (!raw) continue;
    seen += 1;
    const key = normalizeZcta(raw);
    if (key && cachedZctaByKey!.has(key)) hit += 1;
  }
  if (seen === 0) {
    return { kind: 'none', reason: 'ZIP / ZCTA column has no values to validate' };
  }
  const ratio = hit / seen;
  if (ratio < GEOMATCH_LIMITS.MIN_VALIDATION_RATIO) {
    return {
      kind: 'none',
      reason: `ZIP / ZCTA column values matched ${Math.round(ratio * 100)}% (need ${Math.round(GEOMATCH_LIMITS.MIN_VALIDATION_RATIO * 100)}%)`,
    };
  }

  const fields = header.map((name, idx) => ({
    name,
    type: inferFieldType(rows, idx),
  }));

  return {
    kind: 'us-zctas',
    column: header[col.idx]!,
    columnIndex: col.idx,
    header,
    rows,
    fields,
  };
}

export function planCountryGeomatch(text: string): GeomatchDetect {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (detectCsvColumnPair(clean).kind === 'detected') {
    return { kind: 'none', reason: 'File already has coordinates' };
  }
  const parsed = readDelimitedSample(clean, GEOMATCH_LIMITS.MAX_ROWS);
  if ('error' in parsed) return { kind: 'none', reason: parsed.error };

  const { header, rows } = parsed;
  if (bestColumn(header, COUNTY_COLUMN)) {
    return { kind: 'none', reason: 'County column present; defer to county geomatch' };
  }
  if (bestColumn(header, ZCTA_COLUMN)) {
    return { kind: 'none', reason: 'ZIP / ZCTA column present; defer to ZCTA geomatch' };
  }
  const col = bestColumn(header, COUNTRY_COLUMN);
  if (!col) {
    return { kind: 'none', reason: 'No country / ISO column name detected' };
  }

  loadCountryBoundaries();
  const sample = rows.slice(0, GEOMATCH_LIMITS.VALIDATION_SAMPLE_ROWS);
  let hit = 0;
  let seen = 0;
  for (const row of sample) {
    const raw = (row[col.idx] ?? '').trim();
    if (!raw) continue;
    seen += 1;
    if (cachedCountryByKey!.has(normalizeKey(raw))) hit += 1;
  }
  if (seen === 0) {
    return { kind: 'none', reason: 'Country column has no values to validate' };
  }
  const ratio = hit / seen;
  if (ratio < GEOMATCH_LIMITS.MIN_VALIDATION_RATIO) {
    return {
      kind: 'none',
      reason: `Country column values matched ${Math.round(ratio * 100)}% (need ${Math.round(GEOMATCH_LIMITS.MIN_VALIDATION_RATIO * 100)}%)`,
    };
  }

  const fields = header.map((name, idx) => ({
    name,
    type: inferFieldType(rows, idx),
  }));

  return {
    kind: 'countries',
    column: header[col.idx]!,
    columnIndex: col.idx,
    header,
    rows,
    fields,
  };
}

/** Join planned rows to boundary polygons. Unmatched rows are dropped. */
export function featuresFromGeomatch(plan: GeomatchPlan): GeomatchResult {
  if (plan.kind === 'us-counties') return featuresFromUsCountyGeomatch(plan);
  if (plan.kind === 'us-zctas') return featuresFromUsZctaGeomatch(plan);
  if (plan.kind === 'countries') return featuresFromCountryGeomatch(plan);
  return featuresFromUsStateGeomatch(plan);
}

/** @deprecated Prefer featuresFromGeomatch — kept for call-site compatibility. */
export function featuresFromUsStateGeomatch(
  plan: UsStateGeomatchPlan | GeomatchPlan,
): GeomatchResult {
  if (plan.kind === 'us-counties') return featuresFromUsCountyGeomatch(plan);
  if (plan.kind === 'us-zctas') return featuresFromUsZctaGeomatch(plan);
  if (plan.kind === 'countries') return featuresFromCountryGeomatch(plan);
  loadUsStateBoundaries();
  const features: GeomatchResult['geojson']['features'] = [];
  let unmatched = 0;
  for (const row of plan.rows) {
    const raw = (row[plan.columnIndex] ?? '').trim();
    const state = raw ? cachedStateByKey!.get(normalizeKey(raw)) : undefined;
    if (!state) {
      unmatched += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      properties: rowProperties(plan, row, [
        ['state_name', state.name],
        ['state_abbr', state.abbr],
      ]),
      geometry: state.geometry,
    });
  }
  return {
    kind: 'matched',
    boundary: 'us-states',
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

export function featuresFromUsCountyGeomatch(
  plan: UsCountyGeomatchPlan,
): GeomatchResult {
  loadUsCountyBoundaries();
  const features: GeomatchResult['geojson']['features'] = [];
  let unmatched = 0;
  for (const row of plan.rows) {
    const raw = (row[plan.columnIndex] ?? '').trim();
    const stateHint =
      plan.stateColumnIndex !== null
        ? (row[plan.stateColumnIndex] ?? '').trim() || null
        : null;
    const county = raw ? lookupCounty(raw, stateHint) : undefined;
    if (!county) {
      unmatched += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      properties: rowProperties(plan, row, [
        ['county_name', county.name],
        ['state_name', county.stateName],
        ['state_abbr', county.stateAbbr],
        ['county_geoid', county.geoid],
      ]),
      geometry: county.geometry,
    });
  }
  return {
    kind: 'matched',
    boundary: 'us-counties',
    geojson: { type: 'FeatureCollection', features },
    fields: [
      ...plan.fields,
      { name: 'county_name', type: 'string' },
      { name: 'state_name', type: 'string' },
      { name: 'state_abbr', type: 'string' },
      { name: 'county_geoid', type: 'string' },
    ],
    column: plan.column,
    matched: features.length,
    unmatched,
  };
}

export function featuresFromUsZctaGeomatch(
  plan: UsZctaGeomatchPlan,
): GeomatchResult {
  loadUsZctaBoundaries();
  const features: GeomatchResult['geojson']['features'] = [];
  let unmatched = 0;
  for (const row of plan.rows) {
    const raw = (row[plan.columnIndex] ?? '').trim();
    const key = raw ? normalizeZcta(raw) : '';
    const zcta = key ? cachedZctaByKey!.get(key) : undefined;
    if (!zcta) {
      unmatched += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      properties: rowProperties(plan, row, [['zcta', zcta.zcta]]),
      geometry: zcta.geometry,
    });
  }
  return {
    kind: 'matched',
    boundary: 'us-zctas',
    geojson: { type: 'FeatureCollection', features },
    fields: [...plan.fields, { name: 'zcta', type: 'string' }],
    column: plan.column,
    matched: features.length,
    unmatched,
  };
}

export function featuresFromCountryGeomatch(
  plan: CountryGeomatchPlan,
): GeomatchResult {
  loadCountryBoundaries();
  const features: GeomatchResult['geojson']['features'] = [];
  let unmatched = 0;
  for (const row of plan.rows) {
    const raw = (row[plan.columnIndex] ?? '').trim();
    const country = raw
      ? cachedCountryByKey!.get(normalizeKey(raw))
      : undefined;
    if (!country) {
      unmatched += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      properties: rowProperties(plan, row, [
        ['country_name', country.name],
        ['country_iso2', country.iso2],
        ['country_iso3', country.iso3],
      ]),
      geometry: country.geometry,
    });
  }
  return {
    kind: 'matched',
    boundary: 'countries',
    geojson: { type: 'FeatureCollection', features },
    fields: [
      ...plan.fields,
      { name: 'country_name', type: 'string' },
      { name: 'country_iso2', type: 'string' },
      { name: 'country_iso3', type: 'string' },
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

/** Detect + join in one call for the buffer ingest path (counties → states). */
export function detectUsGeomatch(
  text: string,
): GeomatchResult | { kind: 'none'; reason: string } {
  const plan = planUsGeomatch(text);
  if (plan.kind === 'none') return plan;
  const built = featuresFromGeomatch(plan);
  if (built.matched === 0) {
    const reason =
      plan.kind === 'us-counties'
        ? 'No rows matched a US county name'
        : plan.kind === 'us-zctas'
          ? 'No rows matched a US ZIP / ZCTA code'
          : plan.kind === 'countries'
            ? 'No rows matched a country name or ISO code'
            : 'No rows matched a US state name or abbreviation';
    return { kind: 'none', reason };
  }
  return built;
}

/** @deprecated Prefer detectUsGeomatch. */
export function detectUsStateGeomatch(
  text: string,
): GeomatchResult | { kind: 'none'; reason: string } {
  return detectUsGeomatch(text);
}
