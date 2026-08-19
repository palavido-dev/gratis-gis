// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

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
}

const OPS = new Set<AggOp>(['count', 'sum', 'avg', 'min', 'max']);

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

  return out;
}

/**
 * Reject query parameters the endpoint does not implement, by name.
 *
 * Same rule the OGC surface adopted in #28: silently ignoring a
 * filter returns a wrong answer, and a dashboard number that quietly
 * ignored its filter is worse than an error, because nobody reading
 * the dashboard can tell. `where` lives here deliberately until the
 * phase 2 filter widget implements it.
 */
export function rejectUnknownAggregateParams(keys: Iterable<string>): void {
  const allowed = new Set(['agg', 'groupBy', 'bbox', 'limit', 'clip', 'at']);
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
