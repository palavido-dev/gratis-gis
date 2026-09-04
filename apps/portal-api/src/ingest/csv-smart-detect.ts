// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #160 Smart upload Phase 1: coordinate-pair detection.
 *
 * Takes a raw CSV / TSV buffer and tries to figure out which two
 * columns are the latitude / longitude pair, even when the column
 * names are sloppy (LAT, lng, x, y, Y_COORD, latitude_decimal,
 * etc.). When a pair is identified with high confidence, emits a
 * GeoJSON FeatureCollection ready to ingest as a point layer so
 * the user gets a mapped data layer with zero manual schema
 * editing.
 *
 * Detection strategy:
 *   1. Parse the header row, normalize each name (lowercase, drop
 *      non-alphanumerics), score against a vocabulary of known
 *      latitude / longitude column names.
 *   2. For every plausible (lat_col, lng_col) pair, sample the
 *      first N data rows and check that every value falls in the
 *      legal coordinate range (lat in [-90, 90], lng in [-180,
 *      180]). A pair that fails the range check is dropped.
 *   3. Score by how strong the name match is plus how many of the
 *      sampled rows had valid numeric coordinates. Take the
 *      highest-scoring pair, or bail out if no pair scores above
 *      the threshold.
 *
 * Returns `{ kind: 'detected', geojson, fields, latColumn,
 * lngColumn }` on a successful match, or `{ kind: 'no-coords' }`
 * when no plausible pair survives. The caller falls back to the
 * GDAL ingest path in the second case.
 *
 * This is intentionally a tight pure helper with no I/O so the
 * detection logic is unit-testable in isolation.
 */

export interface SmartDetectResult {
  kind: 'detected';
  geojson: { type: 'FeatureCollection'; features: unknown[] };
  fields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
  }>;
  latColumn: string;
  lngColumn: string;
}

export type SmartDetect = SmartDetectResult | { kind: 'no-coords'; reason: string };

/** Tunable thresholds — exported so callers and tests can read the
 *  same constants. */
export const SMART_DETECT_LIMITS = {
  /** Hard cap on header columns. CSV files with thousands of
   *  columns are pathological; refuse politely so we don't burn
   *  RAM on a junk upload. */
  MAX_HEADER_COLUMNS: 256,
  /** Number of data rows sampled to validate that a candidate pair
   *  actually contains coordinates. Detection only requires a few
   *  rows; further validation happens at GeoJSON emit time. */
  VALIDATION_SAMPLE_ROWS: 50,
  /** Minimum fraction of sampled rows that must contain valid
   *  numeric coordinates for a pair to be accepted. */
  MIN_VALIDATION_RATIO: 0.6,
  /** Maximum data rows to emit as Point features in one go. The
   *  existing ingest cap is enforced separately on the caller's
   *  side; this is a defensive upper bound. */
  MAX_FEATURES: 200_000,
};

/** Vocabulary for matching column names to lat / lng intent.
 *  Scores represent confidence; ties are broken in favor of
 *  shorter normalized names. */
const LAT_VOCABULARY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^lat$/, score: 100 },
  { pattern: /^latitude$/, score: 100 },
  { pattern: /^latitudedecimal$/, score: 95 },
  { pattern: /^latdd$/, score: 95 },
  { pattern: /^latdeg$/, score: 90 },
  { pattern: /^lat_?wgs84?$/, score: 90 },
  { pattern: /^pointy$/, score: 80 },
  { pattern: /^geomy$/, score: 80 },
  { pattern: /^y$/, score: 65 },
  { pattern: /^ycoord$/, score: 70 },
  { pattern: /^ycoordinate$/, score: 70 },
  { pattern: /^north(ing)?$/, score: 55 },
];

const LNG_VOCABULARY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^lng$/, score: 100 },
  { pattern: /^lon$/, score: 100 },
  { pattern: /^long$/, score: 95 },
  { pattern: /^longitude$/, score: 100 },
  { pattern: /^longitudedecimal$/, score: 95 },
  { pattern: /^londd$/, score: 95 },
  { pattern: /^londeg$/, score: 90 },
  { pattern: /^lon_?wgs84?$/, score: 90 },
  { pattern: /^pointx$/, score: 80 },
  { pattern: /^geomx$/, score: 80 },
  { pattern: /^x$/, score: 65 },
  { pattern: /^xcoord$/, score: 70 },
  { pattern: /^xcoordinate$/, score: 70 },
  { pattern: /^east(ing)?$/, score: 55 },
];

/** Detection-time confidence floor. A pair below this combined
 *  score doesn't promote to "detected"; the caller falls back to
 *  GDAL. */
const MIN_PAIR_SCORE = 110;

/**
 * The identified coordinate pair, without the FeatureCollection.
 *
 * Split out from detectCsvCoordinates because naming the columns and
 * materialising every row are different jobs with different costs.
 * Naming needs the header plus a validation sample, so it runs
 * happily on the first few KB of a file; materialising needs the
 * whole thing in memory as a string, which does not survive the 1 GB
 * upload ceiling. The ingest path wants the first job only: once it
 * knows which columns hold the coordinates it hands those names to
 * GDAL and lets GDAL stream the file the same way it streams every
 * other format.
 */
export interface CsvColumnPair {
  kind: 'detected';
  latColumn: string;
  lngColumn: string;
  latIndex: number;
  lngIndex: number;
  delimiter: string;
  header: string[];
}

export type CsvColumnDetect =
  | CsvColumnPair
  | { kind: 'no-coords'; reason: string };

/**
 * Name the latitude / longitude columns, if this text has a pair
 * confident enough to act on. Reads the header and at most
 * VALIDATION_SAMPLE_ROWS data rows, so a prefix of a large file is a
 * valid input.
 */
export function detectCsvColumnPair(text: string): CsvColumnDetect {
  if (text.length === 0) {
    return { kind: 'no-coords', reason: 'Empty file' };
  }
  const delimiter = sniffDelimiter(text);
  const lines = splitLines(text);
  if (lines.length < 2) {
    return { kind: 'no-coords', reason: 'Header-only file (no data rows)' };
  }
  const header = parseRow(lines[0]!, delimiter);
  if (header.length === 0 || header.length > SMART_DETECT_LIMITS.MAX_HEADER_COLUMNS) {
    return {
      kind: 'no-coords',
      reason: `Header has ${header.length} columns (max ${SMART_DETECT_LIMITS.MAX_HEADER_COLUMNS})`,
    };
  }
  // Score each header column as candidate lat / lng.
  const latCandidates = header
    .map((raw, idx) => ({ idx, raw, normalized: normalizeName(raw) }))
    .map((c) => ({
      ...c,
      score: bestVocabularyScore(c.normalized, LAT_VOCABULARY),
    }))
    .filter((c) => c.score > 0);
  const lngCandidates = header
    .map((raw, idx) => ({ idx, raw, normalized: normalizeName(raw) }))
    .map((c) => ({
      ...c,
      score: bestVocabularyScore(c.normalized, LNG_VOCABULARY),
    }))
    .filter((c) => c.score > 0);
  if (latCandidates.length === 0 || lngCandidates.length === 0) {
    return {
      kind: 'no-coords',
      reason: 'No latitude / longitude column names detected',
    };
  }
  // Sample data rows once; reuse for every pair's validation.
  const sample: string[][] = [];
  for (
    let i = 1;
    i < lines.length && sample.length < SMART_DETECT_LIMITS.VALIDATION_SAMPLE_ROWS;
    i += 1
  ) {
    const row = parseRow(lines[i]!, delimiter);
    if (row.length === header.length) sample.push(row);
  }
  if (sample.length === 0) {
    return { kind: 'no-coords', reason: 'No parseable data rows' };
  }
  // Score every (lat, lng) cross-combination by name-match strength
  // + validation ratio.
  let bestPair:
    | {
        lat: typeof latCandidates[0];
        lng: typeof lngCandidates[0];
        combinedScore: number;
        validRatio: number;
      }
    | null = null;
  for (const lat of latCandidates) {
    for (const lng of lngCandidates) {
      if (lat.idx === lng.idx) continue;
      const validRatio = validatePairRatio(sample, lat.idx, lng.idx);
      if (validRatio < SMART_DETECT_LIMITS.MIN_VALIDATION_RATIO) continue;
      const combined = Math.round(
        lat.score + lng.score + validRatio * 50 - shortnessTieBreaker(lat, lng),
      );
      if (!bestPair || combined > bestPair.combinedScore) {
        bestPair = { lat, lng, combinedScore: combined, validRatio };
      }
    }
  }
  if (!bestPair || bestPair.combinedScore < MIN_PAIR_SCORE) {
    return {
      kind: 'no-coords',
      reason:
        'No (latitude, longitude) column pair survived value-range validation',
    };
  }
  return {
    kind: 'detected',
    latColumn: header[bestPair.lat.idx]!,
    lngColumn: header[bestPair.lng.idx]!,
    latIndex: bestPair.lat.idx,
    lngIndex: bestPair.lng.idx,
    delimiter,
    header,
  };
}

/**
 * Prefix-safe wrapper. `truncated` says the buffer stops at a byte
 * cap rather than at end of file, in which case the final line is
 * dropped: it may be half a row, or half a multi-byte character, and
 * either way it is not worth reasoning about. Everything the
 * detector needs is in the first handful of rows.
 */
export function detectCsvColumnPairFromPrefix(
  prefix: Buffer,
  truncated: boolean,
): CsvColumnDetect {
  let text = stripBom(prefix.toString('utf8'));
  if (truncated) {
    const lastBreak = text.lastIndexOf('\n');
    text = lastBreak >= 0 ? text.slice(0, lastBreak) : '';
  }
  return detectCsvColumnPair(text);
}

export function detectCsvCoordinates(buffer: Buffer): SmartDetect {
  const text = stripBom(buffer.toString('utf8'));
  const pair = detectCsvColumnPair(text);
  if (pair.kind !== 'detected') return pair;
  // Emit GeoJSON.
  const lines = splitLines(text);
  const fields = inferFieldTypes(pair.header, lines, pair.delimiter);
  const features = emitPoints(
    pair.header,
    lines,
    pair.delimiter,
    pair.latIndex,
    pair.lngIndex,
  );
  return {
    kind: 'detected',
    geojson: { type: 'FeatureCollection', features },
    fields,
    latColumn: pair.latColumn,
    lngColumn: pair.lngColumn,
  };
}

// ---- helpers -----------------------------------------------------------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function splitLines(text: string): string[] {
  // Trim trailing newline so the last line doesn't show up as
  // an empty row through parseRow.
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines;
}

/** Single-character delimiter sniff: count commas, tabs, semicolons
 *  in the first 10 non-empty lines; pick the most common. Defaults
 *  to comma when nothing wins (e.g. single-column files). */
function sniffDelimiter(text: string): ',' | '\t' | ';' {
  const sample = text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 10);
  let commas = 0;
  let tabs = 0;
  let semis = 0;
  for (const line of sample) {
    for (const ch of line) {
      if (ch === ',') commas += 1;
      else if (ch === '\t') tabs += 1;
      else if (ch === ';') semis += 1;
    }
  }
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas && semis > tabs) return ';';
  return ',';
}

/** Minimal CSV row parser with double-quote handling. Single-row
 *  scope; the full CSV spec is unnecessary here because we already
 *  split lines on \n outside. Embedded newlines in quoted fields
 *  aren't supported by this parser; a file that needs that level
 *  of robustness falls back to the GDAL path. */
function parseRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cur.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur);
  return out;
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bestVocabularyScore(
  normalized: string,
  vocab: Array<{ pattern: RegExp; score: number }>,
): number {
  let best = 0;
  for (const entry of vocab) {
    if (entry.pattern.test(normalized) && entry.score > best) {
      best = entry.score;
    }
  }
  return best;
}

/** Prefer short, clean column names over long suffixed variants
 *  when scores tie. E.g. plain `lat` should beat `lat_wgs84`. */
function shortnessTieBreaker(
  lat: { normalized: string },
  lng: { normalized: string },
): number {
  return Math.min(lat.normalized.length + lng.normalized.length, 30);
}

function validatePairRatio(
  sample: string[][],
  latIdx: number,
  lngIdx: number,
): number {
  let valid = 0;
  for (const row of sample) {
    const lat = parseCoordinate(row[latIdx] ?? '');
    const lng = parseCoordinate(row[lngIdx] ?? '');
    if (lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      valid += 1;
    }
  }
  return valid / sample.length;
}

function parseCoordinate(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Accept "1.5", "-1.5", "1,5" (some locales), drop quoted forms.
  // Local-comma decimals only kick in when the value contains
  // exactly one comma and no dot; otherwise we'd corrupt "1,234.5".
  const candidate =
    trimmed.includes(',') && !trimmed.includes('.')
      ? trimmed.replace(',', '.')
      : trimmed;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : null;
}

function inferFieldTypes(
  header: string[],
  lines: string[],
  delimiter: string,
): Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }> {
  const samples: string[][] = [];
  for (let i = 1; i < lines.length && samples.length < 200; i += 1) {
    const row = parseRow(lines[i]!, delimiter);
    if (row.length === header.length) samples.push(row);
  }
  return header.map((name, idx) => {
    let allNumber = true;
    let allBool = true;
    let nonEmpty = 0;
    for (const row of samples) {
      const v = row[idx] ?? '';
      const t = v.trim();
      if (t.length === 0) continue;
      nonEmpty += 1;
      if (!/^-?\d+(\.\d+)?$/.test(t)) allNumber = false;
      if (!/^(true|false|yes|no|0|1)$/i.test(t)) allBool = false;
    }
    if (nonEmpty === 0) return { name, type: 'string' };
    if (allNumber) return { name, type: 'number' };
    if (allBool) return { name, type: 'boolean' };
    return { name, type: 'string' };
  });
}

function emitPoints(
  header: string[],
  lines: string[],
  delimiter: string,
  latIdx: number,
  lngIdx: number,
): unknown[] {
  const out: unknown[] = [];
  for (let i = 1; i < lines.length && out.length < SMART_DETECT_LIMITS.MAX_FEATURES; i += 1) {
    const row = parseRow(lines[i]!, delimiter);
    if (row.length !== header.length) continue;
    const lat = parseCoordinate(row[latIdx] ?? '');
    const lng = parseCoordinate(row[lngIdx] ?? '');
    if (lat === null || lng === null) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const props: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c += 1) {
      if (c === latIdx || c === lngIdx) continue;
      props[header[c]!] = row[c] ?? '';
    }
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: props,
    });
  }
  return out;
}
