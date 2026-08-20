// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type {
  MapFilterOp,
  MapLayerFilter,
  MapLayerFilterClause,
} from '@gratis-gis/shared-types';

/**
 * Query-string parsing for the aggregate endpoint, shared by the
 * authenticated controller and its anonymous mirror so the two can
 * never disagree about what a request means. The authorization is
 * what differs between those surfaces; the vocabulary must not.
 *
 * Wire shape, chosen so a dashboard widget can build it as a plain
 * URL with no client library:
 *
 *   ?agg=count
 *   ?agg=sum:acres&agg=max:acres&groupBy=status
 *   ?agg=count&groupBy=county,status&bbox=w,s,e,n&limit=50
 *
 * Each `agg` is `op` or `op:field`. Result keys are derived from the
 * spec itself (`count`, `sum:acres`), so a caller reading the
 * response never has to correlate by position.
 */

export type AggOp = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggSpec {
  op: AggOp;
  field?: string;
  as: string;
}

export interface ParsedAggregateQuery {
  groupBy: string[];
  aggs: AggSpec[];
  bbox?: [number, number, number, number];
  limit?: number;
  /** Bitemporal read instant, from `?at=`. */
  asOf?: Date;
  /** Attribute predicate, from `?where=`. */
  where?: MapLayerFilter;
  /** Relate scope, from `?via=`. */
  via?: ParsedVia;
}

/**
 * Relate scope: narrow this layer to the rows whose `myField` appears
 * among a PARENT layer's in-scope rows.
 *
 * The parent's scope travels in the same parameter rather than being
 * resolved server-side from saved config, because the parent's scope
 * is a live thing: it is whatever the reader currently has on screen.
 * The server still decides whether the caller may read that parent.
 */
export interface ParsedVia {
  myField: string;
  parentField: string;
  parentItemId: string;
  parentLayerId: string;
  parentBbox?: [number, number, number, number];
  parentWhere?: MapLayerFilter;
}

function parseBbox(raw: unknown, label: string): [number, number, number, number] {
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || !parts.every((x) => Number.isFinite(x))) {
    throw new BadRequestException(
      `${label} must be four comma-separated numbers: west,south,east,north.`,
    );
  }
  const [w, s, e, n] = parts as [number, number, number, number];
  if (s > n) {
    throw new BadRequestException(`${label} south is greater than its north.`);
  }
  return [w, s, e, n];
}

/**
 * Parse `?via=` into a relate scope.
 *
 * JSON in one parameter for the same reason `where` is: the field
 * names and values it carries contain every punctuation character a
 * separator could use.
 */
export function parseVia(raw: unknown): ParsedVia | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) {
    throw new BadRequestException('via must appear once.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new BadRequestException(
      'via must be JSON, e.g. {"parentItemId":"...","parentLayerId":"...",' +
        '"parentField":"well_id","myField":"well_id"}.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('via must be a JSON object.');
  }
  const o = parsed as Record<string, unknown>;
  const str = (key: string): string => {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new BadRequestException(`via.${key} must be a non-empty string.`);
    }
    return v;
  };
  const out: ParsedVia = {
    myField: str('myField'),
    parentField: str('parentField'),
    parentItemId: str('parentItemId'),
    parentLayerId: str('parentLayerId'),
  };
  if (o.parentBbox !== undefined) {
    out.parentBbox = parseBbox(o.parentBbox, 'via.parentBbox');
  }
  if (o.parentWhere !== undefined) {
    const w = parseWhere(JSON.stringify(o.parentWhere));
    if (w) out.parentWhere = w;
  }
  // One hop. A chain is expressible by nesting, and nesting is how a
  // hand-edited item turns into an unbounded query, so it is refused
  // by name rather than depth-counted.
  if (o.via !== undefined) {
    throw new BadRequestException(
      'via.via is not supported; a relate is one hop.',
    );
  }
  return out;
}

const OPS = new Set<AggOp>(['count', 'sum', 'avg', 'min', 'max']);

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

/**
 * A cap on clause count. Each clause is a separate JSONB extraction
 * over the candidate set, and a request carrying two hundred of them
 * is a denial-of-service dressed as a filter, not a dashboard.
 */
const MAX_FILTER_CLAUSES = 20;

/**
 * Parse `?where=` into the same `MapLayerFilter` the map layer and
 * the live-PostGIS service already speak.
 *
 * The transport is JSON in one parameter rather than a punctuated
 * mini-language like `field:op:value`, because the values a filter
 * carries contain the punctuation: a timestamp has colons, a category
 * has commas and slashes ("Cold/Wind Chill"), and every separator
 * choice makes some legitimate value unexpressible. JSON costs one
 * `JSON.stringify` on the client and removes the whole class of
 * quoting bugs.
 *
 * Reusing MapLayerFilter is deliberate: the same predicate a chart
 * click sends to this endpoint is the one the map applies to its own
 * layer, so a chart and the map beside it cannot disagree about what
 * "Heavy Snow" selects.
 */
export function parseWhere(raw: unknown): MapLayerFilter | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) {
    throw new BadRequestException(
      'where must appear once; combine predicates in its clauses array.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new BadRequestException(
      'where must be JSON, e.g. ' +
        '{"combinator":"all","clauses":[{"field":"status","op":"==","value":"open"}]}.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('where must be a JSON object.');
  }
  const obj = parsed as { combinator?: unknown; clauses?: unknown };
  const combinator = obj.combinator ?? 'all';
  if (combinator !== 'all' && combinator !== 'any') {
    throw new BadRequestException(
      'where.combinator must be "all" or "any".',
    );
  }
  if (!Array.isArray(obj.clauses)) {
    throw new BadRequestException('where.clauses must be an array.');
  }
  if (obj.clauses.length === 0) {
    // An empty clause list is ambiguous between "match everything"
    // and "the caller meant to send a filter and built it wrong".
    // Refusing costs a caller one line and removes the guess.
    throw new BadRequestException(
      'where.clauses is empty; omit where entirely to aggregate ' +
        'the whole layer.',
    );
  }
  if (obj.clauses.length > MAX_FILTER_CLAUSES) {
    throw new BadRequestException(
      `where.clauses may hold at most ${MAX_FILTER_CLAUSES} clauses.`,
    );
  }
  const clauses: MapLayerFilterClause[] = obj.clauses.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new BadRequestException(`where.clauses[${i}] must be an object.`);
    }
    const { field, op, value } = c as {
      field?: unknown;
      op?: unknown;
      value?: unknown;
    };
    if (typeof field !== 'string' || field.length === 0) {
      throw new BadRequestException(
        `where.clauses[${i}].field must be a non-empty string.`,
      );
    }
    if (typeof op !== 'string' || !FILTER_OPS.has(op as MapFilterOp)) {
      throw new BadRequestException(
        `where.clauses[${i}].op must be one of: ${[...FILTER_OPS].join(', ')}.`,
      );
    }
    const needsValue = op !== 'is-null' && op !== 'is-not-null';
    if (needsValue && typeof value !== 'string') {
      throw new BadRequestException(
        `where.clauses[${i}].value must be a string for "${op}".`,
      );
    }
    // A comparison operator needs a number to compare against.
    // Postgres would accept the string "abc" as the float NaN and
    // then sort it above everything, so "> abc" would quietly match
    // nothing while "< abc" matched the entire layer. Refuse instead.
    if (
      (op === '>' || op === '>=' || op === '<' || op === '<=') &&
      !Number.isFinite(Number(value))
    ) {
      throw new BadRequestException(
        `where.clauses[${i}].value must be a number for "${op}"; ` +
          `got "${String(value)}".`,
      );
    }
    return {
      field,
      op: op as MapFilterOp,
      value: needsValue ? (value as string) : '',
    };
  });
  return { combinator, clauses };
}

/** Accept both `?agg=a&agg=b` (array) and `?agg=a,b` (comma). */
function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value) ? value.map(String) : String(value).split(',');
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseAggregateQuery(query: {
  agg?: unknown;
  groupBy?: unknown;
  bbox?: unknown;
  limit?: unknown;
  at?: unknown;
  where?: unknown;
  via?: unknown;
}): ParsedAggregateQuery {
  const rawAggs = toList(query.agg);
  if (rawAggs.length === 0) {
    throw new BadRequestException(
      'At least one agg is required, e.g. ?agg=count or ?agg=sum:acres.',
    );
  }
  const aggs: AggSpec[] = rawAggs.map((raw) => {
    const sep = raw.indexOf(':');
    const op = (sep === -1 ? raw : raw.slice(0, sep)) as AggOp;
    const field = sep === -1 ? undefined : raw.slice(sep + 1).trim();
    if (!OPS.has(op)) {
      throw new BadRequestException(
        `Unknown aggregate "${op}". Supported: ${[...OPS].join(', ')}.`,
      );
    }
    if (op === 'count') {
      if (field) {
        // count(field) would imply "count non-null", a different
        // question with a different answer. Refuse rather than
        // silently answering the one we do support.
        throw new BadRequestException(
          'count does not take a field; use ?agg=count.',
        );
      }
      return { op, as: 'count' };
    }
    if (!field) {
      throw new BadRequestException(
        `${op} needs a field, e.g. ?agg=${op}:acres.`,
      );
    }
    return { op, field, as: `${op}:${field}` };
  });

  const groupBy = toList(query.groupBy);

  const out: ParsedAggregateQuery = { groupBy, aggs };

  if (query.bbox !== undefined) {
    const parts = String(query.bbox).split(',').map(Number);
    if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) {
      throw new BadRequestException(
        'bbox must be four comma-separated numbers: west,south,east,north.',
      );
    }
    const [w, s, e, n] = parts as [number, number, number, number];
    if (s > n) {
      throw new BadRequestException('bbox south is greater than its north.');
    }
    out.bbox = [w, s, e, n];
  }

  if (query.at !== undefined) {
    // The time-slider widget scrubs every data-bound widget on a page
    // to the same instant. An aggregate that ignored it would leave a
    // number contradicting the map beside it.
    const d = new Date(String(query.at));
    if (!Number.isFinite(d.getTime())) {
      throw new BadRequestException(
        'at must be an RFC 3339 timestamp, e.g. 2026-08-01T00:00:00Z.',
      );
    }
    out.asOf = d;
  }

  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    out.limit = n;
  }

  const where = parseWhere(query.where);
  if (where) out.where = where;

  const via = parseVia(query.via);
  if (via) out.via = via;

  return out;
}

/**
 * Reject query parameters the endpoint does not implement, by name.
 *
 * Same rule the OGC surface adopted in #28: silently ignoring a
 * filter returns a wrong answer, and a dashboard number that quietly
 * ignored its filter is worse than an error, because nobody reading
 * the dashboard can tell.
 */
export function rejectUnknownAggregateParams(keys: Iterable<string>): void {
  const allowed = new Set([
    'agg',
    'groupBy',
    'bbox',
    'limit',
    'clip',
    'at',
    'where',
    'via',
  ]);
  const unknown = [...keys].filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown query parameter(s): ${unknown.join(', ')}. ` +
        `This endpoint supports: ${[...allowed].join(', ')}. ` +
        'Unsupported filters are rejected rather than ignored, so a ' +
        'filtered request can never return unfiltered numbers.',
    );
  }
}
