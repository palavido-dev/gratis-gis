// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided query builder for the Analyze workbench (#176).
 *
 * Casual users pick fields, filters, grouping, and spatial options
 * from plain controls; the builder generates readable SQL into the
 * panel's editor on every change. The SQL stays visible and the raw
 * editor stays one click away, so the builder teaches the language
 * instead of hiding it, and power users lose nothing.
 *
 * The spatial vocabulary is deliberately the verified-safe set for
 * lon/lat layers: geometry transforms that are CRS-agnostic
 * (centroid, point on surface, convex hull, envelope) and spheroid
 * measures that compute real meters on WGS84 with no projection
 * database (ST_Area_Spheroid and friends, validated against the
 * engine). Buffer-by-meters needs ST_Transform with PROJ data in the
 * browser build, which is unverified, so it is not offered yet
 * rather than offered wrong (a degree-unit buffer would be a trap).
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { FeatureField, LayerGeometryType } from '@gratis-gis/shared-types';

interface FilterRow {
  id: number;
  field: string;
  op: FilterOp;
  value: string;
}

type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'empty'
  | 'notempty';

const STRING_OPS: Array<[FilterOp, string]> = [
  ['eq', 'equals'],
  ['neq', 'does not equal'],
  ['contains', 'contains'],
  ['starts', 'starts with'],
  ['empty', 'is empty'],
  ['notempty', 'is not empty'],
];
const NUMERIC_OPS: Array<[FilterOp, string]> = [
  ['eq', '='],
  ['neq', 'is not'],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
  ['empty', 'is empty'],
  ['notempty', 'is not empty'],
];

type SpatialOp = 'none' | 'centroid' | 'point-on-surface' | 'convex-hull' | 'envelope';

const SPATIAL_OPS: Array<[SpatialOp, string]> = [
  ['none', 'Keep original shapes'],
  ['centroid', 'Centroids'],
  ['point-on-surface', 'Points inside each shape'],
  ['convex-hull', 'Convex hulls'],
  ['envelope', 'Bounding boxes'],
];

const SPATIAL_FN: Record<Exclude<SpatialOp, 'none'>, string> = {
  centroid: 'ST_Centroid',
  'point-on-surface': 'ST_PointOnSurface',
  'convex-hull': 'ST_ConvexHull',
  envelope: 'ST_Envelope',
};

type Measure = 'area' | 'length' | 'perimeter';

interface Props {
  viewName: string;
  fields: FeatureField[];
  geometryType: LayerGeometryType;
  spatialAvailable: boolean;
  /** Fires with regenerated SQL on every builder change. */
  onSql: (sql: string) => void;
}

let nextFilterId = 1;

export function AnalyzeQueryBuilder({
  viewName,
  fields,
  geometryType,
  spatialAvailable,
  onSql,
}: Props) {
  const [pickedFields, setPickedFields] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [spatialOp, setSpatialOp] = useState<SpatialOp>('none');
  const [measures, setMeasures] = useState<Set<Measure>>(new Set());
  const [groupByField, setGroupByField] = useState<string>('');
  const [aggFn, setAggFn] = useState<'none' | 'sum' | 'avg' | 'min' | 'max'>('none');
  const [aggField, setAggField] = useState<string>('');
  const [orderField, setOrderField] = useState<string>('');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const [limit, setLimit] = useState<string>('100');

  const hasGeometry = geometryType !== null;
  const numericFields = useMemo(
    () => fields.filter((f) => f.type === 'number'),
    [fields],
  );
  // Which measures make sense for this geometry family. Points have
  // no meaningful spheroid measure; a centroid/hull transform can
  // change the family, but measures always apply to the ORIGINAL
  // geometry, so the family gate stays honest.
  const availableMeasures: Array<[Measure, string]> =
    geometryType === 'polygon'
      ? [
          ['area', 'Area (sq m)'],
          ['perimeter', 'Perimeter (m)'],
        ]
      : geometryType === 'line'
        ? [['length', 'Length (m)']]
        : [];

  const sql = useMemo(
    () =>
      buildSql({
        viewName,
        fields,
        pickedFields,
        filters,
        spatialOp: spatialAvailable && hasGeometry ? spatialOp : 'none',
        measures: spatialAvailable ? measures : new Set<Measure>(),
        includeGeometry: hasGeometry,
        groupByField,
        aggFn,
        aggField,
        orderField,
        orderDir,
        limit,
      }),
    [
      viewName,
      fields,
      pickedFields,
      filters,
      spatialOp,
      measures,
      hasGeometry,
      spatialAvailable,
      groupByField,
      aggFn,
      aggField,
      orderField,
      orderDir,
      limit,
    ],
  );

  // Push regenerated SQL up whenever the built query changes,
  // including the initial default, so the editor preview is always
  // live. The parent decides when to RUN it.
  useEffect(() => {
    onSql(sql);
  }, [sql, onSql]);

  function toggleField(name: string): void {
    setPickedFields((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function updateFilter(id: number, patch: Partial<FilterRow>): void {
    setFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  }

  const selectClass =
    'h-7 rounded border border-border bg-surface-1 px-1.5 text-2xs text-ink-1 focus:border-accent focus:outline-none';
  const inputClass =
    'h-7 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 focus:border-accent focus:outline-none';
  const sectionLabel =
    'text-2xs font-medium uppercase tracking-wide text-muted';

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
      {/* Fields: empty selection means every field, which is the
          right default for exploration. */}
      <div>
        <div className={sectionLabel}>
          Fields{' '}
          <span className="normal-case tracking-normal">
            (none selected = all)
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {fields.map((f) => {
            const active = pickedFields.has(f.name);
            return (
              <button
                key={f.name}
                type="button"
                onClick={() => toggleField(f.name)}
                aria-pressed={active}
                className={`rounded-full border px-2 py-0.5 text-2xs transition-colors ${
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                }`}
              >
                {f.label || f.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters: AND semantics, one row per condition. */}
      <div>
        <div className="flex items-center justify-between">
          <span className={sectionLabel}>Filters (all must match)</span>
          <button
            type="button"
            onClick={() =>
              setFilters((prev) => [
                ...prev,
                {
                  id: nextFilterId++,
                  field: fields[0]?.name ?? '',
                  op: 'eq',
                  value: '',
                },
              ])
            }
            className="inline-flex items-center gap-1 text-2xs text-accent hover:underline"
          >
            <Plus className="h-3 w-3" />
            Add filter
          </button>
        </div>
        {filters.length > 0 ? (
          <div className="mt-1.5 space-y-1.5">
            {filters.map((row) => {
              const field = fields.find((f) => f.name === row.field);
              const ops =
                field?.type === 'number' || field?.type === 'date'
                  ? NUMERIC_OPS
                  : STRING_OPS;
              const needsValue = row.op !== 'empty' && row.op !== 'notempty';
              const coded =
                field?.domain?.type === 'coded-value'
                  ? field.domain.values
                  : null;
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={row.field}
                    onChange={(e) =>
                      updateFilter(row.id, { field: e.target.value, op: 'eq', value: '' })
                    }
                    className={selectClass}
                    aria-label="Filter field"
                  >
                    {fields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label || f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={row.op}
                    onChange={(e) =>
                      updateFilter(row.id, { op: e.target.value as FilterOp })
                    }
                    className={selectClass}
                    aria-label="Filter operator"
                  >
                    {ops.map(([op, label]) => (
                      <option key={op} value={op}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {needsValue ? (
                    coded ? (
                      <select
                        value={row.value}
                        onChange={(e) =>
                          updateFilter(row.id, { value: e.target.value })
                        }
                        className={selectClass}
                        aria-label="Filter value"
                      >
                        <option value="">(pick a value)</option>
                        {coded.map((v) => (
                          <option key={String(v.code)} value={String(v.code)}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={field?.type === 'number' ? 'number' : 'text'}
                        value={row.value}
                        onChange={(e) =>
                          updateFilter(row.id, { value: e.target.value })
                        }
                        placeholder={field?.type === 'date' ? '2026-01-31' : 'value'}
                        className={`${inputClass} w-36`}
                        aria-label="Filter value"
                      />
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      setFilters((prev) => prev.filter((f) => f.id !== row.id))
                    }
                    aria-label="Remove filter"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Spatial: only when the layer has geometry and the extension
          loaded. Transforms replace the output geometry; measures add
          real-meter columns computed on the spheroid. */}
      {hasGeometry && spatialAvailable ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-2xs text-ink-1">
            <span className={sectionLabel}>Geometry</span>
            <select
              value={spatialOp}
              onChange={(e) => setSpatialOp(e.target.value as SpatialOp)}
              className={selectClass}
            >
              {SPATIAL_OPS.map(([op, label]) => (
                <option key={op} value={op}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {availableMeasures.map(([m, label]) => (
            <label key={m} className="flex items-center gap-1 text-2xs text-ink-1">
              <input
                type="checkbox"
                checked={measures.has(m)}
                onChange={() =>
                  setMeasures((prev) => {
                    const next = new Set(prev);
                    if (next.has(m)) next.delete(m);
                    else next.add(m);
                    return next;
                  })
                }
                className="h-3.5 w-3.5 accent-accent"
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}

      {/* Group + order + limit in one compact row. Grouping drops
          geometry from the output (the result is a table). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <label className="flex items-center gap-1.5 text-2xs text-ink-1">
          <span className={sectionLabel}>Group by</span>
          <select
            value={groupByField}
            onChange={(e) => setGroupByField(e.target.value)}
            className={selectClass}
          >
            <option value="">(no grouping)</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label || f.name}
              </option>
            ))}
          </select>
        </label>
        {groupByField && numericFields.length > 0 ? (
          <label className="flex items-center gap-1.5 text-2xs text-ink-1">
            <span className={sectionLabel}>Also</span>
            <select
              value={aggFn}
              onChange={(e) => setAggFn(e.target.value as typeof aggFn)}
              className={selectClass}
            >
              <option value="none">(count only)</option>
              <option value="sum">sum of</option>
              <option value="avg">average of</option>
              <option value="min">min of</option>
              <option value="max">max of</option>
            </select>
            {aggFn !== 'none' ? (
              <select
                value={aggField}
                onChange={(e) => setAggField(e.target.value)}
                className={selectClass}
              >
                <option value="">(pick a field)</option>
                {numericFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label || f.name}
                  </option>
                ))}
              </select>
            ) : null}
          </label>
        ) : null}
        <label className="flex items-center gap-1.5 text-2xs text-ink-1">
          <span className={sectionLabel}>Sort</span>
          <select
            value={orderField}
            onChange={(e) => setOrderField(e.target.value)}
            className={selectClass}
          >
            <option value="">(none)</option>
            {groupByField ? (
              <option value="__count__">count</option>
            ) : null}
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label || f.name}
              </option>
            ))}
          </select>
          {orderField ? (
            <select
              value={orderDir}
              onChange={(e) => setOrderDir(e.target.value as 'asc' | 'desc')}
              className={selectClass}
            >
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
          ) : null}
        </label>
        <label className="flex items-center gap-1.5 text-2xs text-ink-1">
          <span className={sectionLabel}>Limit</span>
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className={`${inputClass} w-20`}
          />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Literal for a filter value under the field's declared type.
 *  Numbers emit bare only when they parse (otherwise quoted, which
 *  simply matches nothing rather than breaking the query); strings
 *  and dates emit as escaped string literals (DuckDB casts the
 *  literal for a TIMESTAMP comparison). */
function valueLiteral(field: FeatureField | undefined, raw: string): string {
  if (field?.type === 'number') {
    const n = Number(raw);
    if (Number.isFinite(n) && raw.trim() !== '') return String(n);
  }
  return quoteString(raw);
}

function filterToSql(fields: FeatureField[], row: FilterRow): string | null {
  const field = fields.find((f) => f.name === row.field);
  if (!field) return null;
  const col = quoteIdent(field.name);
  switch (row.op) {
    case 'empty':
      return `(${col} IS NULL OR ${col}::VARCHAR = '')`;
    case 'notempty':
      return `(${col} IS NOT NULL AND ${col}::VARCHAR <> '')`;
    case 'contains':
      return `${col} ILIKE ${quoteString(`%${row.value}%`)}`;
    case 'starts':
      return `${col} ILIKE ${quoteString(`${row.value}%`)}`;
    case 'eq':
      return `${col} = ${valueLiteral(field, row.value)}`;
    case 'neq':
      return `${col} <> ${valueLiteral(field, row.value)}`;
    case 'gt':
      return `${col} > ${valueLiteral(field, row.value)}`;
    case 'gte':
      return `${col} >= ${valueLiteral(field, row.value)}`;
    case 'lt':
      return `${col} < ${valueLiteral(field, row.value)}`;
    case 'lte':
      return `${col} <= ${valueLiteral(field, row.value)}`;
  }
}

const MEASURE_EXPR: Record<Measure, string> = {
  area: 'round(ST_Area_Spheroid(geometry), 1) AS area_sq_m',
  length: 'round(ST_Length_Spheroid(geometry), 1) AS length_m',
  perimeter: 'round(ST_Perimeter_Spheroid(geometry), 1) AS perimeter_m',
};

function buildSql(args: {
  viewName: string;
  fields: FeatureField[];
  pickedFields: Set<string>;
  filters: FilterRow[];
  spatialOp: SpatialOp;
  measures: Set<Measure>;
  includeGeometry: boolean;
  groupByField: string;
  aggFn: 'none' | 'sum' | 'avg' | 'min' | 'max';
  aggField: string;
  orderField: string;
  orderDir: 'asc' | 'desc';
  limit: string;
}): string {
  const view = quoteIdent(args.viewName);
  const lines: string[] = [];

  if (args.groupByField) {
    // Aggregation query: grouped field + count (+ one optional
    // numeric aggregate). Geometry is dropped; the result is a table.
    const parts = [quoteIdent(args.groupByField), 'count(*) AS features'];
    if (args.aggFn !== 'none' && args.aggField) {
      parts.push(
        `round(${args.aggFn}(${quoteIdent(args.aggField)}), 2) AS ${args.aggFn}_${args.aggField.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      );
    }
    lines.push(`SELECT ${parts.join(',\n       ')}`);
  } else {
    const picked =
      args.pickedFields.size > 0
        ? args.fields.filter((f) => args.pickedFields.has(f.name))
        : null;
    const parts: string[] = [];
    if (picked) {
      parts.push(...picked.map((f) => quoteIdent(f.name)));
    }
    if (args.includeGeometry) {
      const geomExpr =
        args.spatialOp === 'none'
          ? null
          : `${SPATIAL_FN[args.spatialOp]}(geometry) AS geometry`;
      if (picked) {
        parts.push(geomExpr ?? 'geometry');
      } else if (geomExpr) {
        // All fields with a transformed geometry: REPLACE keeps every
        // other column while swapping the geometry expression.
        parts.push(`* REPLACE (${geomExpr.replace(' AS geometry', '')} AS geometry)`);
      } else {
        parts.push('*');
      }
    } else if (!picked) {
      parts.push('*');
    }
    for (const m of args.measures) {
      parts.push(MEASURE_EXPR[m]);
    }
    lines.push(`SELECT ${parts.join(',\n       ')}`);
  }

  lines.push(`FROM ${view}`);

  // A filter row with an empty value is "still being typed", not a
  // condition; only the null-check operators are meaningful without
  // a value, so incomplete rows stay out of the WHERE clause.
  const activeWhere = args.filters
    .filter((row) => row.op === 'empty' || row.op === 'notempty' || row.value !== '')
    .map((row) => filterToSql(args.fields, row))
    .filter((s): s is string => s !== null);
  if (activeWhere.length > 0) {
    lines.push(`WHERE ${activeWhere.join('\n  AND ')}`);
  }

  if (args.groupByField) {
    lines.push('GROUP BY 1');
  }

  if (args.orderField) {
    const col =
      args.orderField === '__count__'
        ? 'features'
        : quoteIdent(args.orderField);
    lines.push(`ORDER BY ${col} ${args.orderDir.toUpperCase()}`);
  }

  const limitN = Number(args.limit);
  if (Number.isFinite(limitN) && limitN > 0) {
    lines.push(`LIMIT ${Math.floor(limitN)}`);
  }

  return lines.join('\n');
}
