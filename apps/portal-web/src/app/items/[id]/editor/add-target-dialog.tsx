'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, Loader2, Search, X } from 'lucide-react';
import type {
  DataLayerData,
  DataLayerSublayer,
  Item,
} from '@gratis-gis/shared-types';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Set of data_layer item ids already targeted by the parent
   * Editor. Each (dataLayerId, layerKey) combo can only appear
   * once, so we grey out already-added entries to keep the user
   * from creating duplicates.
   */
  existingTargets: ReadonlySet<string>;
  onAdd: (input: {
    dataLayerId: string;
    layerKey: string;
    layer: DataLayerSublayer;
    dataLayerTitle: string;
  }) => void;
}

/**
 * Two-step picker for adding an Editor target:
 *
 *   1. Pick a data_layer item from the portal (search-first list).
 *   2. Within that item, pick which sublayer to target.
 *
 * Only v3 data_layers (multi-layer PostGIS) are eligible because
 * v1/v2 inline-GeoJSON storage doesn't expose the per-layer
 * `editingEnabled` / `editingPolicy` plumbing the Editor relies
 * on. Layers with `editingEnabled: false` show up but cannot be
 * picked: the picker surfaces them so users see the gap and know
 * to flip the toggle on the data_layer's detail page.
 *
 * Pattern cribbed from add-layer-dialog.tsx (the maps "Add layer"
 * flow). Differences worth flagging:
 *   - we filter to data_layer only (Editor doesn't target arcgis_service)
 *   - lite=1 fetch keeps the list cheap; full item fetch happens
 *     only after a click
 *   - duplicate detection: `existingTargets` keyed
 *     "<dataLayerId>:<layerKey>"
 */
export function AddTargetDialog({
  open,
  onClose,
  existingTargets,
  onAdd,
}: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  // After a data_layer is picked, hold its full item shape so we
  // can render the sublayer chooser in the second step.
  const [selected, setSelected] = useState<Item | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setItems([]);
    setQ('');
    setSelected(null);
    setSelectedLoading(false);
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Search data_layer items on mount + on query changes. Same
  // lite=1 + AbortController pattern as add-layer-dialog.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ type: 'data_layer', lite: '1' });
        const trimmed = q.trim();
        if (trimmed) qs.set('q', trimmed);
        const res = await fetch(`/api/portal/items?${qs}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) setItems([]);
          return;
        }
        const list = (await res.json()) as Item[];
        if (cancelled) return;
        list.sort((a, b) => {
          const at = new Date(a.updatedAt ?? 0).getTime();
          const bt = new Date(b.updatedAt ?? 0).getTime();
          return bt - at;
        });
        setItems(list);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.warn('[editor:add-target] fetch failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(handle);
    };
  }, [open, q]);

  // When user picks a data_layer, fetch the full item to get the
  // layers list. lite=1 strips data; we need the real shape now.
  async function pickItem(item: Item) {
    setSelectedLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${item.id}`);
      if (!res.ok) {
        setError(`Couldn't load layers: ${res.status}`);
        return;
      }
      const full = (await res.json()) as Item;
      setSelected(full);
    } finally {
      setSelectedLoading(false);
    }
  }

  function pickSublayer(layer: DataLayerSublayer) {
    if (!selected) return;
    onAdd({
      dataLayerId: selected.id,
      layerKey: layer.id,
      layer,
      dataLayerTitle: selected.title,
    });
    handleClose();
  }

  function handleClose() {
    reset();
    onClose();
  }

  if (!open) return null;

  // Compute v3 layer list from the selected item. v1/v2 (inline
  // GeoJSON) data_layers are surfaced as "not eligible" rather
  // than hidden entirely so users see why their old layers
  // aren't targetable.
  const data = selected?.data as DataLayerData | undefined;
  const v3Layers: DataLayerSublayer[] | null =
    data && data.version === 3 ? data.layers : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-0">
              {selected ? `Pick a layer in "${selected.title}"` : 'Add a target layer'}
            </h2>
            <p className="text-xs text-muted">
              {selected
                ? 'Each editor target points at one layer inside a data layer item.'
                : 'Pick a data layer item; then choose the sublayer the editor will expose.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!selected ? (
          <>
            <div className="border-b border-border px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted" />
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search data layers..."
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-7 pr-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {loading && items.length === 0 ? (
                <div className="flex items-center justify-center px-4 py-8 text-sm text-muted">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading...
                </div>
              ) : items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted">
                  No data layers match "{q}".
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => void pickItem(item)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                      >
                        <Layers className="h-4 w-4 shrink-0 text-sky-600" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink-0">
                            {item.title}
                          </div>
                          {item.description ? (
                            <div className="truncate text-xs text-muted">
                              {item.description}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-auto">
            {selectedLoading ? (
              <div className="flex items-center justify-center px-4 py-8 text-sm text-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading layers...
              </div>
            ) : v3Layers === null ? (
              <div className="px-4 py-6 text-sm">
                <p className="mb-2 text-ink-1">
                  This data layer uses an older single-layer storage format
                  that does not expose per-layer editing controls.
                </p>
                <p className="text-xs text-muted">
                  The Editor targets v3 (multi-layer PostGIS) data layers.
                  Open this item's detail page and migrate it to v3 to use
                  it here.
                </p>
              </div>
            ) : v3Layers.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                This data layer has no layers configured yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {v3Layers.map((layer) => {
                  const key = `${selected.id}:${layer.id}`;
                  const already = existingTargets.has(key);
                  const editable = layer.editingEnabled;
                  const disabled = already || !editable;
                  const tooltip = already
                    ? 'Already a target'
                    : !editable
                      ? 'Editing is disabled on this layer. Turn it on in the data layer\'s detail page first.'
                      : '';
                  return (
                    <li key={layer.id}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => pickSublayer(layer)}
                        title={tooltip}
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left ${
                          disabled
                            ? 'cursor-not-allowed opacity-50'
                            : 'hover:bg-surface-2'
                        }`}
                      >
                        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-ink-0">
                              {layer.label}
                            </span>
                            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                              {layer.geometryType ?? 'table'}
                            </span>
                          </div>
                          <div className="text-xs text-muted">
                            {layer.fields.length} field
                            {layer.fields.length === 1 ? '' : 's'}
                            {layer.editingPolicy === 'own-rows-only'
                              ? ' / own-rows policy'
                              : ''}
                            {!editable ? ' / editing disabled' : ''}
                          </div>
                        </div>
                        {already ? (
                          <span className="text-[11px] uppercase tracking-wide text-muted">
                            added
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {error ? (
              <p className="px-4 pb-3 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          {selected ? (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-sm text-muted hover:text-ink-0"
            >
              Back to data layers
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
