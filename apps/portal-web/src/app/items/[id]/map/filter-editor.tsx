// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { Plus, Trash2, X } from 'lucide-react';
import type {
  MapFilterOp,
  MapLayerFilter,
  MapLayerFilterClause,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  value: MapLayerFilter | null;
  metadata: LayerMetadata;
  onChange: (next: MapLayerFilter | null) => void;
}

/**
 * Multi-clause attribute filter. Users can AND or OR multiple where-
 * clauses together. Incomplete clauses (missing field, non-numeric
 * value on a numeric operator) are dropped at render time by the
 * canvas, so the map stays responsive while the user is mid-edit.
 *
 * Nested boolean trees are out of scope here; if real workloads want
 * them, they can land as a v2.3 when we know the shape they need.
 */
export function FilterEditor({ value, metadata, onChange }: Props) {
  const active = value !== null;

  function start() {
    onChange({ combinator: 'all', clauses: [{ field: '', op: '==', value: '' }] });
  }

  function update(next: MapLayerFilter) {
    onChange(next);
  }

  function addClause() {
    if (!value) return;
    update({
      ...value,
      clauses: [...value.clauses, { field: '', op: '==', value: '' }],
    });
  }

  function patchClause(idx: number, patch: Partial<MapLayerFilterClause>) {
    if (!value) return;
    update({
      ...value,
      clauses: value.clauses.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    });
  }

  function removeClause(idx: number) {
    if (!value) return;
    const next = value.clauses.filter((_, i) => i !== idx);
    if (next.length === 0) {
      onChange(null);
      return;
    }
    update({ ...value, clauses: next });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {active ? 'Clauses' : 'No filter'}
          </span>
          {active ? (
            <select
              value={value.combinator}
              onChange={(e) =>
                update({ ...value, combinator: e.target.value as 'all' | 'any' })
              }
              className="h-6 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="all">match ALL</option>
              <option value="any">match ANY</option>
            </select>
          ) : null}
        </div>
        {active ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex h-6 items-center gap-1 rounded text-2xs text-muted hover:text-danger"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            className="inline-flex h-6 items-center gap-1 rounded text-2xs text-accent hover:underline"
          >
            <Plus className="h-3 w-3" />
            Add filter
          </button>
        )}
      </div>

      {active ? (
        <div className="space-y-2">
          {value.clauses.map((clause, idx) => (
            <Clause
              key={idx}
              clause={clause}
              metadata={metadata}
              onChange={(p) => patchClause(idx, p)}
              onRemove={() => removeClause(idx)}
            />
          ))}
          <button
            type="button"
            onClick={addClause}
            className="inline-flex h-7 items-center gap-1 rounded text-2xs text-accent hover:underline"
          >
            <Plus className="h-3 w-3" />
            Add clause
          </button>
          {metadata.loading ? (
            <p className="text-2xs text-muted">Loading fields...</p>
          ) : metadata.error ? (
            <p className="text-2xs text-warn">{metadata.error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Clause({
  clause,
  metadata,
  onChange,
  onRemove,
}: {
  clause: MapLayerFilterClause;
  metadata: LayerMetadata;
  onChange: (patch: Partial<MapLayerFilterClause>) => void;
  onRemove: () => void;
}) {
  const needsValue = clause.op !== 'is-null' && clause.op !== 'is-not-null';
  const valueOptions = clause.field ? metadata.valuesByField[clause.field] ?? [] : [];

  return (
    <div className="rounded border border-border bg-surface-1 p-2">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          {metadata.fields.length > 0 ? (
            <select
              value={clause.field}
              onChange={(e) => onChange({ field: e.target.value })}
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="">Pick a field...</option>
              {metadata.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={clause.field}
              onChange={(e) => onChange({ field: e.target.value })}
              placeholder="field"
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          )}
          <div className="flex gap-1.5">
            <select
              value={clause.op}
              onChange={(e) => onChange({ op: e.target.value as MapFilterOp })}
              className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="==">==</option>
              <option value="!=">!=</option>
              <option value=">">&gt;</option>
              <option value=">=">&gt;=</option>
              <option value="<">&lt;</option>
              <option value="<=">&lt;=</option>
              <option value="contains">contains</option>
              <option value="is-null">is empty</option>
              <option value="is-not-null">is not empty</option>
            </select>
            {needsValue ? (
              valueOptions.length > 0 &&
              (clause.op === '==' || clause.op === '!=') ? (
                <select
                  value={clause.value}
                  onChange={(e) => onChange({ value: e.target.value })}
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                >
                  <option value="">Pick a value...</option>
                  {valueOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={clause.value}
                  onChange={(e) => onChange({ value: e.target.value })}
                  placeholder="value"
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              )
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove clause"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
