// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ChartBin,
  MapLayerFilter,
  NumberFormat,
} from '@gratis-gis/shared-types';

/**
 * Client for the server-side aggregate endpoint, shared by the
 * indicator and chart widgets.
 *
 * Both widgets used to (chart) or would have to (indicator) download
 * a layer's whole GeoJSON and reduce it in the browser. That does not
 * survive a county-scale layer, and it cannot be scoped: the numbers
 * a viewer sees have to come from a query that applied that viewer's
 * share limits. This module is the small amount of plumbing that
 * makes "ask the server" as easy as the wrong thing was.
 *
 * The BFF forwards /api/portal/... to portal-api and falls back to
 * the anonymous public mirror when there is no session, so the same
 * URL works signed in and signed out.
 */

export type AggOp =
  | 'count'
  | 'countDistinct'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max';

export interface AggregateRequest {
  itemId: string;
  layerId: string;
  aggs: Array<{ op: AggOp; field?: string }>;
  groupBy?: string[];
  bbox?: [number, number, number, number];
  /**
   * Attribute predicate, sent as JSON in one parameter.
   *
   * Same `MapLayerFilter` the map applies to its own layer, so a
   * chart and the map beside it cannot disagree about what a
   * cross-filter selection means.
   */
  where?: MapLayerFilter;
  /**
   * Relate scope: narrow to rows whose key appears among a parent
   * layer's in-scope rows. Compiled server-side as a semi-join, so
   * the parent's scope travels here rather than a harvested list of
   * its keys, which would cap out and go quietly short.
   */
  via?: {
    myField: string;
    parentField: string;
    parentItemId: string;
    parentLayerId: string;
    parentBbox?: [number, number, number, number];
    parentWhere?: MapLayerFilter;
  };
  /**
   * Bitemporal read instant, from the app's time slider.
   *
   * Callers were already passing this and it was being dropped on
   * the floor: the field was missing from this interface, and an
   * object spread bypasses TypeScript's excess-property check, so a
   * scrubbed dashboard showed today's numbers next to a historical
   * map with nothing on screen to say so.
   */
  asOf?: string;
  /**
   * Bin a numeric field into ranges, adding one group level so the
   * result describes a distribution rather than one group per distinct
   * reading.
   *
   * `count` and `width` modes let the server measure the field's range
   * against the same scope the bars come from, which is the only way
   * the axis can be guaranteed to match its own data.
   */
  bin?: ChartBin;
  limit?: number;
  signal?: AbortSignal;
}

export interface AggregateGroup {
  key: Record<string, string | null>;
  values: Record<string, number | null>;
  /**
   * Present on a binned request. Half-open `[lower, upper)`, with null
   * on an open side: `{lower: null, upper: 0.3}` is "under 0.3", not
   * "unknown". On a censored measurement column that bucket is
   * routinely the biggest one, so rendering null as a blank label
   * throws away the tallest bar.
   */
  bin?: { lower: number | null; upper: number | null };
}

export interface AggregateResult {
  groups: AggregateGroup[];
  truncated: boolean;
  /** Thresholds the server used, ascending. Binned requests only. */
  binEdges?: number[];
}

/**
 * Label one bucket for an axis.
 *
 * Open-ended buckets read as "under x" / "x and up" rather than as a
 * range with a blank end, because a reader scanning an axis should not
 * have to work out that an empty bound means infinity.
 */
export function formatBinLabel(
  bin: { lower: number | null; upper: number | null } | undefined,
): string {
  if (!bin) return '—';
  const n = (v: number): string =>
    new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(v);
  if (bin.lower === null && bin.upper === null) return 'No value';
  if (bin.lower === null) return `under ${n(bin.upper!)}`;
  if (bin.upper === null) return `${n(bin.lower)} and up`;
  return `${n(bin.lower)} to ${n(bin.upper)}`;
}

/**
 * The filter a click on one histogram bar means.
 *
 * Half-open on purpose, matching how the bucket was computed: a
 * closed range would double-count every value that sits exactly on an
 * edge, so the selection would not sum back to the bar it came from.
 * Returns null for the no-value bucket, which is not expressible as a
 * range and should not silently select everything.
 */
export function binFilterFor(
  field: string,
  bin: { lower: number | null; upper: number | null } | undefined,
): MapLayerFilter | null {
  if (!bin || (bin.lower === null && bin.upper === null)) return null;
  const clauses: MapLayerFilter['clauses'] = [];
  if (bin.lower !== null) {
    clauses.push({ field, op: '>=', value: String(bin.lower) });
  }
  if (bin.upper !== null) {
    clauses.push({ field, op: '<', value: String(bin.upper) });
  }
  return { combinator: 'all', clauses };
}

/** The result key the server assigns a spec: `count`, `sum:acres`. */
export function aggKey(op: AggOp, field?: string): string {
  return op === 'count' ? 'count' : `${op}:${field ?? ''}`;
}

/** Ops that summarise a measurement, and so need a numeric field. */
export const NUMERIC_AGG_OPS: ReadonlySet<AggOp> = new Set<AggOp>([
  'sum',
  'avg',
  'min',
  'max',
]);

export async function fetchAggregate(
  req: AggregateRequest,
): Promise<AggregateResult> {
  const params = new URLSearchParams();
  for (const a of req.aggs) {
    params.append('agg', a.op === 'count' ? 'count' : `${a.op}:${a.field}`);
  }
  if (req.groupBy && req.groupBy.length > 0) {
    params.set('groupBy', req.groupBy.join(','));
  }
  if (req.bbox) params.set('bbox', req.bbox.join(','));
  if (req.where) params.set('where', JSON.stringify(req.where));
  if (req.via) params.set('via', JSON.stringify(req.via));
  if (req.bin) params.set('bin', JSON.stringify(req.bin));
  if (req.asOf) params.set('at', req.asOf);
  if (req.limit !== undefined) params.set('limit', String(req.limit));

  const res = await fetch(
    `/api/portal/items/${req.itemId}/layers/${req.layerId}/aggregate?${params.toString()}`,
    req.signal ? { signal: req.signal } : {},
  );
  if (!res.ok) {
    // Surface the server's sentence when it sent one. The endpoint
    // refuses unknown filters and unknown field names by name, and
    // that message is the whole reason it refuses instead of
    // answering with a confident wrong number.
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string | string[] };
      const m = body?.message;
      detail = Array.isArray(m) ? m.join('; ') : (m ?? '');
    } catch {
      /* non-JSON error body; fall through to the status text */
    }
    throw new Error(detail || `Could not load data (HTTP ${res.status}).`);
  }
  return (await res.json()) as AggregateResult;
}

/**
 * Render an aggregate for display.
 *
 * Compact mode is opt-in rather than automatic: "1,240 permits" is
 * more useful than "1.2K permits" on the kind of counts a portal
 * deals with, and rounding a number the reader is about to act on is
 * a small betrayal. Authors who genuinely want the short form (a
 * population, a budget) turn it on.
 */
export function formatAggregateValue(
  value: number | null | undefined,
  fmt: NumberFormat | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const grouping = fmt?.grouping !== false;
  const opts: Intl.NumberFormatOptions = { useGrouping: grouping };
  if (fmt?.compact) {
    opts.notation = 'compact';
    opts.maximumFractionDigits = fmt.decimals ?? 1;
  } else if (fmt?.decimals !== undefined) {
    opts.minimumFractionDigits = fmt.decimals;
    opts.maximumFractionDigits = fmt.decimals;
  } else if (Number.isInteger(value) || Math.abs(value) >= 1000) {
    // Integers print bare, and so does anything past a thousand: a
    // summed deck area rendering as "798,587.58" spends two digits
    // on precision the reader did not ask for and cannot use. Below a
    // thousand the fraction usually IS the point (an average rating
    // of 6.4, a mean depth of 12.75).
    opts.maximumFractionDigits = 0;
  } else {
    opts.maximumFractionDigits = 2;
  }
  const body = new Intl.NumberFormat(undefined, opts).format(value);
  return `${fmt?.prefix ?? ''}${body}${fmt?.suffix ?? ''}`;
}

/** Default caption when the author has not written one. */
export function defaultIndicatorLabel(
  aggregate: AggOp,
  valueField: string | undefined,
  layerName: string | undefined,
): string {
  const subject = layerName?.trim() || 'records';
  if (aggregate === 'count') return `Count of ${subject}`;
  const field = valueField?.trim();
  if (aggregate === 'countDistinct') {
    return field ? `Distinct ${field}` : `Distinct values`;
  }
  const verb =
    aggregate === 'sum'
      ? 'Total'
      : aggregate === 'avg'
        ? 'Average'
        : aggregate === 'min'
          ? 'Lowest'
          : 'Highest';
  return field ? `${verb} ${field}` : `${verb} value`;
}

/**
 * #77: union bbox of the rows a predicate keeps, for "zoom to the
 * filtered features". Same `where` / `via` vocabulary as
 * fetchAggregate, deliberately WITHOUT a bbox input: the extent must
 * be independent of the current viewport or the map could never zoom
 * back out to rows that scrolled off screen.
 */
export async function fetchFilteredExtent(req: {
  itemId: string;
  layerId: string;
  where?: MapLayerFilter;
  via?: AggregateRequest['via'];
  asOf?: string;
  signal?: AbortSignal;
}): Promise<[number, number, number, number] | null> {
  const params = new URLSearchParams();
  if (req.where) params.set('where', JSON.stringify(req.where));
  if (req.via) params.set('via', JSON.stringify(req.via));
  if (req.asOf) params.set('at', req.asOf);
  const res = await fetch(
    `/api/portal/items/${req.itemId}/layers/${req.layerId}/filtered-extent?${params.toString()}`,
    req.signal ? { signal: req.signal } : {},
  );
  if (!res.ok) {
    throw new Error(`Could not resolve the filtered extent (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as {
    bbox: [number, number, number, number] | null;
  };
  return body.bbox;
}
