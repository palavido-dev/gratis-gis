// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Address-column detection for a CSV that has no latitude / longitude
 * pair. Names the column (or the street + city parts) and builds one
 * query string per row. Geocoding itself stays outside this file so
 * the choice of which rows to send is unit-testable with no network.
 */

import {
  detectCsvColumnPair,
  readDelimitedSample,
} from './csv-smart-detect.js';

export const ADDRESS_GEOCODE_LIMITS = {
  /** First rows of a spreadsheet that are sent to the local geocoder.
   *  A county-scale address file is not a bulk geocode job. */
  MAX_ROWS: 200,
  /** How many of those rows are inspected before a column is trusted. */
  VALIDATION_SAMPLE_ROWS: 50,
  /** Share of the sample that must look like an address. */
  MIN_VALIDATION_RATIO: 0.6,
};

const FULL_ADDRESS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^address$/, score: 100 },
  { pattern: /^fulladdress$/, score: 100 },
  { pattern: /^siteaddress$/, score: 95 },
  { pattern: /^mailingaddress$/, score: 92 },
  { pattern: /^propertyaddress$/, score: 92 },
];

const STREET: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^street$/, score: 100 },
  { pattern: /^streetaddress$/, score: 95 },
  { pattern: /^address1$/, score: 90 },
  { pattern: /^addr1$/, score: 90 },
  { pattern: /^addressline1$/, score: 90 },
  { pattern: /^addr$/, score: 80 },
  { pattern: /^road$/, score: 70 },
];

const CITY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^city$/, score: 100 },
  { pattern: /^town$/, score: 90 },
  { pattern: /^locality$/, score: 80 },
];

const REGION: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^state$/, score: 100 },
  { pattern: /^region$/, score: 90 },
  { pattern: /^province$/, score: 90 },
];

const POSTAL: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^zip$/, score: 100 },
  { pattern: /^zipcode$/, score: 100 },
  { pattern: /^postalcode$/, score: 95 },
  { pattern: /^postcode$/, score: 95 },
  { pattern: /^postal$/, score: 80 },
];

export interface AddressColumnPlan {
  kind: 'address';
  /** What the author will see in a log line: one column, or the parts. */
  label: string;
  header: string[];
  rows: string[][];
  /** Parallel to `rows`. Empty when that row has nothing to look up. */
  queries: string[];
  fields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
  }>;
}

export type AddressPlan = AddressColumnPlan | { kind: 'none'; reason: string };

export function planAddressGeocode(text: string): AddressPlan {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (detectCsvColumnPair(clean).kind === 'detected') {
    return { kind: 'none', reason: 'File already has coordinates' };
  }
  const parsed = readDelimitedSample(clean, ADDRESS_GEOCODE_LIMITS.MAX_ROWS);
  if ('error' in parsed) return { kind: 'none', reason: parsed.error };

  const { header, rows } = parsed;
  const full = bestColumn(header, FULL_ADDRESS);
  const street = bestColumn(header, STREET);
  const city = bestColumn(header, CITY);
  const region = bestColumn(header, REGION, [street?.idx, city?.idx]);
  const postal = bestColumn(header, POSTAL, [street?.idx, city?.idx, region?.idx]);

  const candidates: Array<{ label: string; queries: string[] }> = [];
  if (full) {
    candidates.push({
      label: header[full.idx]!,
      queries: rows.map((row) => (row[full.idx] ?? '').trim()),
    });
  }
  if (street && city) {
    const parts = [street.idx, city.idx, region?.idx, postal?.idx].filter(
      (idx): idx is number => idx !== undefined,
    );
    candidates.push({
      label: parts.map((idx) => header[idx]!).join(', '),
      queries: rows.map((row) =>
        parts
          .map((idx) => (row[idx] ?? '').trim())
          .filter((part) => part.length > 0)
          .join(', '),
      ),
    });
  } else if (street && !full) {
    candidates.push({
      label: header[street.idx]!,
      queries: rows.map((row) => (row[street.idx] ?? '').trim()),
    });
  }

  for (const candidate of candidates) {
    if (addressRatio(candidate.queries) >= ADDRESS_GEOCODE_LIMITS.MIN_VALIDATION_RATIO) {
      return {
        kind: 'address',
        label: candidate.label,
        header,
        rows,
        queries: candidate.queries,
        fields: inferFields(header, rows),
      };
    }
  }
  return {
    kind: 'none',
    reason: 'No address column survived a check of the sample rows',
  };
}

export function featuresFromAddresses(
  plan: AddressColumnPlan,
  hits: Array<{ lat: number; lon: number } | null>,
): {
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
  placed: number;
} {
  const features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }> = [];
  for (let i = 0; i < plan.rows.length; i += 1) {
    const hit = hits[i];
    if (!hit) continue;
    const row = plan.rows[i]!;
    const properties: Record<string, unknown> = {};
    for (let c = 0; c < plan.header.length; c += 1) {
      const field = plan.fields[c]!;
      properties[field.name] = coerce(row[c] ?? '', field.type);
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [hit.lon, hit.lat] },
      properties,
    });
  }
  return { features, placed: features.length };
}

function bestColumn(
  header: string[],
  vocab: Array<{ pattern: RegExp; score: number }>,
  skip: Array<number | undefined> = [],
): { idx: number; score: number } | null {
  let best: { idx: number; score: number } | null = null;
  header.forEach((raw, idx) => {
    if (skip.includes(idx)) return;
    const score = scoreName(raw, vocab);
    if (score > 0 && (!best || score > best.score)) best = { idx, score };
  });
  return best;
}

function scoreName(
  raw: string,
  vocab: Array<{ pattern: RegExp; score: number }>,
): number {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = 0;
  for (const entry of vocab) {
    if (entry.pattern.test(normalized) && entry.score > best) best = entry.score;
  }
  return best;
}

function addressRatio(queries: string[]): number {
  const sample = queries.slice(0, ADDRESS_GEOCODE_LIMITS.VALIDATION_SAMPLE_ROWS);
  if (sample.length === 0) return 0;
  let ok = 0;
  for (const query of sample) {
    if (looksLikeAddress(query)) ok += 1;
  }
  return ok / sample.length;
}

function looksLikeAddress(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 6) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

function inferFields(
  header: string[],
  rows: string[][],
): Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }> {
  return header.map((name, idx) => {
    let allNumber = true;
    let allBool = true;
    let nonEmpty = 0;
    for (const row of rows.slice(0, 200)) {
      const trimmed = (row[idx] ?? '').trim();
      if (trimmed.length === 0) continue;
      nonEmpty += 1;
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) allNumber = false;
      if (!/^(true|false|yes|no|0|1)$/i.test(trimmed)) allBool = false;
    }
    if (nonEmpty === 0) return { name, type: 'string' };
    if (allNumber) return { name, type: 'number' };
    if (allBool) return { name, type: 'boolean' };
    return { name, type: 'string' };
  });
}

function coerce(
  value: string,
  type: 'string' | 'number' | 'boolean' | 'date',
): unknown {
  const trimmed = value.trim();
  if (type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (type === 'boolean') {
    if (/^(true|yes|1)$/i.test(trimmed)) return true;
    if (/^(false|no|0)$/i.test(trimmed)) return false;
  }
  return value;
}
