'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, X } from 'lucide-react';
import type {
  ArcgisServiceData,
  DataLayerData,
  ItemWithShares,
} from '@gratis-gis/shared-types';

/**
 * Right-side drawer that shows a quick preview of a layer's
 * attributes without leaving the items list (#82). Capped at
 * PREVIEW_LIMIT features so a large dataset doesn't lock up the
 * browser; an overflow notice points the user at the map editor
 * for the full table view.
 *
 * Two source paths:
 *   - data_layer (V3 only)  -> /api/portal/items/<id>/layers/<layerId>/geojson
 *   - arcgis_service        -> /api/portal/items/<id>/proxy/<sublayerId>/query?...
 *
 * The proxy path means a secured ArcGIS service previews the same
 * way as a public one: credential injection is handled server-side.
 */

const PREVIEW_LIMIT = 500;

type SublayerOption = {
  id: string | number;
  label: string;
  /** Truthy when the sublayer has no geometry (a "table"). */
  isTable: boolean;
};

interface Props {
  item: ItemWithShares;
  onClose: () => void;
}

export function DataPreviewDrawer({ item, onClose }: Props) {
  const sublayers = useMemo(() => extractSublayers(item), [item]);
  const [activeId, setActiveId] = useState<string | number | null>(
    sublayers[0]?.id ?? null,
  );
  const [features, setFeatures] = useState<GeoJSON.Feature[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overflow, setOverflow] = useState(false);

  // Close on Escape so the drawer feels modal even though it's a
  // side panel. Body click outside the drawer also closes via the
  // backdrop element in the JSX below.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fetch the active sublayer's features when the drawer opens or
  // the sublayer pick changes. Aborts the prior request so a fast
  // sublayer-flip doesn't paint stale data.
  useEffect(() => {
    if (activeId == null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setOverflow(false);
    setFeatures([]);
    void (async () => {
      try {
        const url = buildFetchUrl(item, activeId);
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
          );
        }
        const json = (await res.json()) as
          | { features?: unknown; error?: { message?: unknown } }
          | unknown;
        if (controller.signal.aborted) return;
        // Detect the ArcGIS 200-with-error envelope so we surface
        // a meaningful message instead of "fetch returned 0
        // features".
        if (
          json &&
          typeof json === 'object' &&
          'error' in (json as Record<string, unknown>)
        ) {
          const err = (json as { error?: { message?: unknown } }).error;
          throw new Error(
            typeof err?.message === 'string'
              ? err.message
              : 'Upstream returned an error',
          );
        }
        const fc =
          json && typeof json === 'object' && 'features' in json
            ? ((json as { features: unknown[] }).features ?? [])
            : [];
        const list = Array.isArray(fc) ? (fc as GeoJSON.Feature[]) : [];
        if (list.length >= PREVIEW_LIMIT) setOverflow(true);
        setFeatures(list.slice(0, PREVIEW_LIMIT));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : 'Could not load preview. Open the item to see details.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [item, activeId]);

  const fields = useMemo(() => collectFields(features), [features]);
  const activeSublayer = sublayers.find((s) => s.id === activeId) ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Data preview"
      className="fixed inset-0 z-40 flex"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the panel are
        // captured by the inner <aside> stopPropagation handler.
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <aside
        className="flex w-full max-w-3xl flex-col border-l border-border bg-surface-1 shadow-overlay"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Preview
            </p>
            <h2 className="mt-0.5 truncate text-base font-semibold text-ink-0">
              {item.title}
            </h2>
            <Link
              href={`/items/${item.id}`}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent hover:underline"
            >
              Open item
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Sublayer picker. Hidden when there's only one option;
            shown as a dropdown when multiple sublayers exist (V3
            multi-layer data_layer or multi-sublayer arcgis_service). */}
        {sublayers.length > 1 ? (
          <div className="border-b border-border bg-surface-2 px-4 py-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted">Layer</span>
              <select
                value={String(activeId ?? '')}
                onChange={(e) => {
                  const next = e.target.value;
                  // Sublayer ids are either string (data_layer
                  // sublayer.id is a stable string) or number
                  // (arcgis_service sublayer.id is the integer
                  // ArcGIS layerId). We coerce based on the
                  // original entry's typeof.
                  const match = sublayers.find((s) => String(s.id) === next);
                  setActiveId(match?.id ?? null);
                }}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs"
              >
                {sublayers.map((s) => (
                  <option key={String(s.id)} value={String(s.id)}>
                    {s.label}
                    {s.isTable ? ' (table)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : error ? (
            <div className="m-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          ) : features.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted">
              No features in this layer.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="border-b border-border bg-surface-2 px-4 py-1.5 text-[11px] text-muted">
                {features.length}
                {overflow ? `+ of many` : ''} feature
                {features.length === 1 ? '' : 's'}
                {fields.length > 0 ? ` • ${fields.length} field` : ''}
                {fields.length === 1 ? '' : fields.length > 0 ? 's' : ''}
              </div>
              {/* Compact, Excel-ish table: every row is a single
                  line with overflow ellipsised, so a long
                  "generalnotes" cell doesn't blow the row up to
                  six lines tall. table-fixed + per-column max-width
                  keeps the layout predictable; the user sees more
                  rows on screen and can hover for the full value
                  via the title attribute. Zebra rows for
                  readability. (#83) */}
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="min-w-full table-fixed text-[11px]">
                  <thead className="sticky top-0 z-10 bg-surface-2 text-left">
                    <tr>
                      {fields.map((f) => (
                        <th
                          key={f}
                          title={f}
                          className="truncate border-b border-border px-2 py-1 font-medium text-muted"
                          style={{ maxWidth: '12rem', minWidth: '6rem' }}
                        >
                          {f}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((feat, i) => (
                      <tr
                        key={i}
                        className={`${
                          i % 2 === 1 ? 'bg-surface-2/40' : ''
                        } hover:bg-accent/5`}
                      >
                        {fields.map((f) => {
                          const value = formatCell(feat.properties?.[f]);
                          return (
                            <td
                              key={f}
                              title={value}
                              className="truncate border-b border-border/40 px-2 py-0.5 text-ink-1"
                              style={{ maxWidth: '12rem', minWidth: '6rem' }}
                            >
                              {value}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {overflow ? (
                <div className="border-t border-border bg-amber-50/50 px-4 py-2 text-[11px] text-amber-900">
                  Showing the first {PREVIEW_LIMIT} features. Open the
                  item&apos;s map editor for the full attribute table.
                </div>
              ) : null}
            </div>
          )}
        </div>

        {activeSublayer ? (
          <footer className="border-t border-border bg-surface-2 px-4 py-2 text-[11px] text-muted">
            Layer: <span className="text-ink-1">{activeSublayer.label}</span>
            {activeSublayer.isTable ? (
              <span className="ml-2 rounded border border-border bg-surface-1 px-1.5 py-0.5 uppercase tracking-wide">
                table
              </span>
            ) : null}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

function extractSublayers(item: ItemWithShares): SublayerOption[] {
  if (item.type === 'data_layer') {
    const data = item.data as DataLayerData | null;
    if (data && 'version' in data && data.version === 3) {
      return data.layers.map((l) => ({
        id: l.id,
        label: l.label || l.name || `Layer ${l.id}`,
        isTable: l.geometryType === null,
      }));
    }
    // v1 / v2: a single implicit layer; we don't need a picker.
    return [{ id: 'self', label: 'Features', isTable: false }];
  }
  if (item.type === 'arcgis_service') {
    const data = item.data as ArcgisServiceData | null;
    const all = data?.layers ?? [];
    const selected = new Set(data?.selectedLayerIds ?? []);
    const filtered = all.filter((l) => selected.size === 0 || selected.has(l.id));
    return filtered.map((l) => ({
      id: l.id,
      label: l.name || `Layer ${l.id}`,
      // ArcGIS marks tables with no geometryType. We surfaced them
      // earlier with " (table)" appended; strip that for the option
      // label since we already badge separately.
      isTable: !l.geometryType,
    }));
  }
  return [];
}

function buildFetchUrl(
  item: ItemWithShares,
  sublayerId: string | number,
): string {
  if (item.type === 'data_layer') {
    if (sublayerId === 'self') {
      return `/api/portal/items/${item.id}/geojson`;
    }
    return `/api/portal/items/${item.id}/layers/${encodeURIComponent(
      String(sublayerId),
    )}/geojson?limit=${PREVIEW_LIMIT}`;
  }
  // arcgis_service: query the sublayer through the per-item proxy
  // so credentials apply automatically. resultRecordCount caps the
  // server-side response; we slice client-side too as belt-and-
  // suspenders.
  const qs = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: String(PREVIEW_LIMIT),
  });
  return `/api/portal/items/${item.id}/proxy/${encodeURIComponent(
    String(sublayerId),
  )}/query?${qs.toString()}`;
}

function collectFields(features: GeoJSON.Feature[]): string[] {
  const set = new Set<string>();
  for (const f of features) {
    const props = f.properties ?? {};
    for (const k of Object.keys(props)) set.add(k);
  }
  // Stable order: alphabetical with underscore-prefixed system
  // fields (created_at, created_by, etc.) at the end so the
  // user's own attributes lead.
  const sorted = Array.from(set).sort((a, b) => {
    const aSys = a.startsWith('_');
    const bSys = b.startsWith('_');
    if (aSys !== bSys) return aSys ? 1 : -1;
    return a.localeCompare(b);
  });
  return sorted;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Dates from ArcGIS come through as epoch millis. We can't tell
  // those apart from arbitrary numbers without schema context, so
  // just stringify here.
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
