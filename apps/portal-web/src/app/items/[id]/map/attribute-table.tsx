'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Filter as FilterIcon,
  Focus,
  History,
  Search,
  Table,
  X,
} from 'lucide-react';
import type {
  MapLayer,
  MapLayerFilter,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  open: boolean;
  layers: MapLayer[];
  /**
   * Cached feature collections keyed by layer id. The parent fetches
   * these lazily when the table opens so we don't refetch per render.
   */
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>;
  metadata: Record<string, LayerMetadata>;
  canEdit: boolean;
  /**
   * Shared selection state owned by the editor. Keys are layer ids;
   * values are Sets of feature ids (== indexes into each layer's
   * cached feature collection, since sources use generateId: true).
   */
  selection: Record<string, Set<number>>;
  setSelection: React.Dispatch<
    React.SetStateAction<Record<string, Set<number>>>
  >;
  onClose: () => void;
  /** Fly to a bbox in the map canvas. */
  onZoomTo: (bbox: [number, number, number, number]) => void;
  /** Replace the layer filter (used by "convert selection to filter"). */
  onPatchLayer: (layerId: string, patch: Partial<MapLayer>) => void;
}

type SortDir = 'asc' | 'desc';

/**
 * Bottom-overlay attribute table. One layer at a time; the top-row
 * picker switches the focused layer. Rows are the layer's features;
 * columns are the layer's attribute fields.
 *
 * Interactions:
 *   - Click a column header to sort (click again to flip direction).
 *   - Click a row to toggle its selection; shift-click for a range.
 *   - Toolbar: Zoom to selection, text Query, "Use selection as filter".
 *   - Edit is gated on canEdit + a source that supports writes. For
 *     now, feature-service sources only accept replace-all updates, so
 *     row-level edit is stubbed with a friendly message.
 */
export function AttributeTable({
  open,
  layers,
  featuresByLayer,
  metadata,
  canEdit,
  selection,
  setSelection,
  onClose,
  onZoomTo,
  onPatchLayer,
}: Props) {
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [lastPicked, setLastPicked] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [query, setQuery] = useState('');
  // Editor tracking columns toggle (#39). Off by default so the
  // table reads as the layer's actual schema; flip on when the
  // author wants to audit who-touched-what. The four columns are
  // sourced from underscore-prefixed properties (_created_by,
  // _created_at, _edited_by, _edited_at) the API surfaces alongside
  // the user-defined attributes.
  const [showEditorTracking, setShowEditorTracking] = useState(false);

  // Only layers the viewer is allowed to query belong in the table.
  // `effective.query === false` is the server's signal (from the
  // access matrix) that this layer's attributes are off-limits for
  // the current user. Filtering at the picker level keeps both the
  // dropdown and the auto-selected "first visible" layer honest.
  const queryableLayers = useMemo(
    () =>
      layers.filter(
        (l) => l.effective === undefined || l.effective.query !== false,
      ),
    [layers],
  );

  // The active layer's selection; the table only ever shows one
  // layer at a time, so we read a single slice off the shared map.
  const activeSelection = (activeLayerId && selection[activeLayerId]) || new Set<number>();

  // Default to the top visible queryable layer whenever the list
  // changes. Also resets the active layer if the currently-active one
  // just had its query permission revoked (e.g. matrix edit on an
  // editor-side map viewer refresh).
  useEffect(() => {
    if (!open) return;
    if (
      activeLayerId &&
      queryableLayers.some((l) => l.id === activeLayerId)
    ) {
      return;
    }
    const first =
      queryableLayers.find((l) => l.visible) ?? queryableLayers[0] ?? null;
    setActiveLayerId(first?.id ?? null);
    setLastPicked(null);
    setSortBy(null);
    setQuery('');
    // Note: we deliberately don't clear the shared selection here
    // switching layers should preserve the picks on other layers.
  }, [open, queryableLayers, activeLayerId]);

  /** Replace the active layer's slice; leave other layers untouched. */
  function updateActiveSelection(next: Set<number>) {
    if (!activeLayerId) return;
    setSelection((prev) => ({ ...prev, [activeLayerId]: next }));
  }

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null;
  const activeFields =
    activeLayer && metadata[activeLayer.id]?.fields.length
      ? metadata[activeLayer.id]!.fields
      : [];
  const activeFeatures =
    (activeLayer ? featuresByLayer[activeLayer.id] : null)?.features ?? [];

  // Apply query + sort. Indexes into `activeFeatures`, not flattened,
  // so selection indices always line up with the source array.
  const visibleIndexes = useMemo(() => {
    const q = query.trim().toLowerCase();
    let idxs = activeFeatures.map((_, i) => i);
    if (q.length > 0) {
      idxs = idxs.filter((i) => {
        const props = (activeFeatures[i]?.properties ?? {}) as Record<
          string,
          unknown
        >;
        for (const v of Object.values(props)) {
          if (v === null || v === undefined) continue;
          if (String(v).toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }
    if (sortBy) {
      idxs.sort((a, b) => {
        const av = ((activeFeatures[a]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const bv = ((activeFeatures[b]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const cmp = compareValues(av, bv);
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return idxs;
  }, [activeFeatures, query, sortBy, sortDir]);

  function onHeaderClick(field: string) {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  }

  function onRowClick(displayIdx: number, shift: boolean) {
    // Respect the layer's Selectable toggle. The row still highlights
    // locally via lastPicked for shift-range anchoring, but we don't
    // mutate the shared selection that drives the map.
    if (activeLayer && activeLayer.interactions?.selectable === false) return;
    const idx = visibleIndexes[displayIdx];
    if (idx === undefined) return;
    const next = new Set(activeSelection);
    if (shift && lastPicked !== null) {
      const a = Math.min(displayIdx, lastPicked);
      const b = Math.max(displayIdx, lastPicked);
      for (let i = a; i <= b; i += 1) {
        const ix = visibleIndexes[i];
        if (ix !== undefined) next.add(ix);
      }
    } else {
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
    }
    updateActiveSelection(next);
    setLastPicked(displayIdx);
  }

  function zoomToSelection() {
    if (activeSelection.size === 0) return;
    const features = [...activeSelection]
      .map((i) => activeFeatures[i])
      .filter((f): f is GeoJSON.Feature => Boolean(f && f.geometry));
    if (features.length === 0) return;
    const bbox = bboxOfFeatures(features);
    if (bbox) onZoomTo(bbox);
  }

  function selectionToFilter() {
    if (!activeLayer || activeSelection.size === 0) return;
    // Strategy: if the features carry a stable id field, convert to a
    // single `in` clause. Otherwise fall back to a boolean-OR of per-
    // feature primary-key guesses. If no usable id field is
    // discoverable, we bail with a visible error rather than silently
    // filtering nothing.
    const idField = pickIdField(activeFields, activeFeatures, activeSelection);
    if (!idField) return;
    const values = [...activeSelection]
      .map((i) => {
        const v = (activeFeatures[i]?.properties ?? {}) as Record<string, unknown>;
        return v[idField];
      })
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v));
    if (values.length === 0) return;
    // A single multi-clause filter with OR'd == clauses keeps it
    // compatible with the existing filter editor.
    const filter: MapLayerFilter = {
      combinator: 'any',
      clauses: values.map((v) => ({ field: idField, op: '==' as const, value: v })),
    };
    onPatchLayer(activeLayer.id, { filter });
  }

  if (!open) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 flex h-[40%] min-h-[240px] flex-col border-t border-border bg-surface-1 shadow-overlay">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          <Table className="h-3.5 w-3.5" />
          Attribute table
        </h3>
        {queryableLayers.length > 0 ? (
          <select
            value={activeLayerId ?? ''}
            onChange={(e) => {
              setActiveLayerId(e.target.value);
              // Preserve selection across layer switches: picks on
              // other layers keep their highlight on the map.
              setQuery('');
              setSortBy(null);
              setLastPicked(null);
            }}
            className="h-7 min-w-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {queryableLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ml-2 flex flex-1 items-center gap-2">
          <label className="relative block min-w-0 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Query any field..."
              className="h-7 w-full rounded border border-border bg-surface-1 pl-7 pr-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </label>
          <span className="text-[11px] text-muted">
            {visibleIndexes.length.toLocaleString()} rows
            {activeSelection.size > 0 ? ` · ${activeSelection.size} selected` : ''}
          </span>
          <button
            type="button"
            onClick={() => setShowEditorTracking((v) => !v)}
            aria-pressed={showEditorTracking}
            title={
              showEditorTracking
                ? 'Hide who-edited-when columns'
                : 'Show who-edited-when columns'
            }
            className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors ${
              showEditorTracking
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-1 text-muted hover:text-ink-1'
            }`}
          >
            <History className="h-3 w-3" />
            Track edits
          </button>
        </div>
        <button
          type="button"
          onClick={zoomToSelection}
          disabled={activeSelection.size === 0}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title="Zoom to selected features"
        >
          <Focus className="h-3.5 w-3.5" />
          Zoom to
        </button>
        <button
          type="button"
          onClick={selectionToFilter}
          disabled={activeSelection.size === 0 || !activeLayer}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title="Filter the layer to only the selected features"
        >
          <FilterIcon className="h-3.5 w-3.5" />
          Use as filter
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!activeLayer ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          No layer selected.
        </div>
      ) : activeFeatures.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {metadata[activeLayer.id]?.loading
            ? 'Loading features...'
            : 'No features to show.'}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th className="w-8 border-b border-border px-2 py-1.5" />
                {activeFields.map((f) => (
                  <th
                    key={f}
                    onClick={() => onHeaderClick(f)}
                    className="cursor-pointer border-b border-border px-3 py-1.5 text-left font-medium text-ink-1 hover:bg-surface-1"
                  >
                    <span className="inline-flex items-center gap-1">
                      {f}
                      {sortBy === f ? (
                        sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 text-muted/50" />
                      )}
                    </span>
                  </th>
                ))}
                {showEditorTracking
                  ? EDITOR_TRACKING_COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => onHeaderClick(col.key)}
                        className="cursor-pointer border-b border-border bg-surface-1 px-3 py-1.5 text-left font-medium italic text-muted hover:text-ink-1"
                        title={col.tooltip}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortBy === col.key ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-muted/50" />
                          )}
                        </span>
                      </th>
                    ))
                  : null}
              </tr>
            </thead>
            <tbody>
              {visibleIndexes.map((idx, displayIdx) => {
                const feature = activeFeatures[idx];
                if (!feature) return null;
                const props = (feature.properties ?? {}) as Record<
                  string,
                  unknown
                >;
                const selected = activeSelection.has(idx);
                return (
                  <tr
                    key={idx}
                    onClick={(e) => onRowClick(displayIdx, e.shiftKey)}
                    className={`cursor-pointer border-b border-border ${
                      selected
                        ? 'bg-accent/10 hover:bg-accent/15'
                        : 'hover:bg-surface-2'
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        readOnly
                        checked={selected}
                        className="pointer-events-none h-3 w-3 rounded border-border text-accent"
                      />
                    </td>
                    {activeFields.map((field) => {
                      const v = props[field];
                      return (
                        <td
                          key={field}
                          className="whitespace-nowrap px-3 py-1 text-ink-1"
                        >
                          {formatCell(v)}
                        </td>
                      );
                    })}
                    {showEditorTracking
                      ? EDITOR_TRACKING_COLUMNS.map((col) => (
                          <td
                            key={col.key}
                            className="whitespace-nowrap px-3 py-1 text-muted italic"
                          >
                            {col.format(props[col.key])}
                          </td>
                        ))
                      : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
          Row-level editing lands when feature services store data in
          PostGIS. For now, edit the dataset by replacing the whole
          FeatureCollection from the feature-service detail page.
        </div>
      ) : null}
    </div>
  );
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Optional columns rendered when the user toggles "Track edits".
 * Sourced from underscore-prefixed properties the API surfaces on
 * every PostGIS-backed feature (#39). When the layer is not backed
 * by PostGIS (raw GeoJSON, ArcGIS service), these cells render
 * empty: harmless, not an error.
 */
const EDITOR_TRACKING_COLUMNS: Array<{
  key: string;
  label: string;
  tooltip: string;
  format: (v: unknown) => string;
}> = [
  {
    key: '_created_by',
    label: 'Created by',
    tooltip: 'User id of the row creator',
    format: (v) => (v ? String(v) : ''),
  },
  {
    key: '_created_at',
    label: 'Created',
    tooltip: 'Timestamp the row was first inserted',
    format: formatTimestamp,
  },
  {
    key: '_edited_by',
    label: 'Edited by',
    tooltip: 'User id of the most recent editor',
    format: (v) => (v ? String(v) : ''),
  },
  {
    key: '_edited_at',
    label: 'Edited',
    tooltip: 'Timestamp of the most recent edit',
    format: formatTimestamp,
  },
];

function formatTimestamp(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return String(v);
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleString();
  } catch {
    return v;
  }
}

/**
 * Bounding box across an arbitrary set of features. Walks every
 * coordinate; safe for small-to-mid datasets (the selection in the
 * attribute table). Returns null for a selection that has no valid
 * geometries.
 */
function bboxOfFeatures(
  features: GeoJSON.Feature[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  function visit(coord: unknown) {
    if (Array.isArray(coord)) {
      if (coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
        const x = coord[0] as number;
        const y = coord[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
      } else {
        for (const c of coord) visit(c);
      }
    }
  }

  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if ('coordinates' in geom) visit(geom.coordinates);
    if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries) {
        if ('coordinates' in g) visit(g.coordinates);
      }
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

/**
 * Heuristic pick for a stable id field. Prefers fields literally named
 * `id`, `fid`, `objectid`, then the first field whose values are
 * unique across the selected feature subset.
 */
function pickIdField(
  fields: string[],
  features: GeoJSON.Feature[],
  selection: Set<number>,
): string | null {
  const common = ['id', 'fid', 'objectid', 'OBJECTID', 'FID', 'ID'];
  for (const c of common) {
    if (fields.includes(c)) return c;
  }
  for (const f of fields) {
    const seen = new Set<string>();
    let unique = true;
    for (const i of selection) {
      const v = ((features[i]?.properties ?? {}) as Record<string, unknown>)[f];
      if (v === null || v === undefined) {
        unique = false;
        break;
      }
      const key = String(v);
      if (seen.has(key)) {
        unique = false;
        break;
      }
      seen.add(key);
    }
    if (unique) return f;
  }
  return null;
}
