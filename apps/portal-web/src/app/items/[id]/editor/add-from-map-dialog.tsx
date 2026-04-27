'use client';

import { useEffect, useMemo, useState } from 'react';
import { Layers, Loader2, X } from 'lucide-react';
import type {
  DataLayerData,
  DataLayerSublayer,
  Item,
  MapData,
} from '@gratis-gis/shared-types';
import { PickMapDialog } from './pick-map-dialog';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Set of `<dataLayerId>:<layerKey>` strings already present in the
   * Editor's targets list. Pre-checked sublayers stay unchecked +
   * disabled here so the user cannot re-add a duplicate.
   */
  existingTargets: ReadonlySet<string>;
  /**
   * The Editor's currently-referenced map id, if any. Used as the
   * default starting map for the bulk import (skipping the picker
   * step) so the typical "I already picked a basemap map; just
   * import its editable layers" flow is one click. Pass undefined
   * to always start with the picker.
   */
  defaultMapId?: string | undefined;
  /**
   * Called with the full list of new EditorTarget seeds the user
   * confirmed. The parent merges them into the targets array.
   */
  onAdd: (
    additions: Array<{
      dataLayerId: string;
      layerKey: string;
      layer: DataLayerSublayer;
      dataLayerTitle: string;
    }>,
  ) => void;
}

interface Candidate {
  /** Composite key matching existingTargets entries. */
  key: string;
  dataLayerId: string;
  dataLayerTitle: string;
  layer: DataLayerSublayer;
  /** True when this layer is already a target (greyed out, unchecked). */
  alreadyTarget: boolean;
  /** True when the layer cannot be edited. Surfaced for clarity. */
  notEditable: boolean;
}

/**
 * "Add from map" bulk-import flow for Editor targets.
 *
 * Step 1: pick a map (skipped when defaultMapId is set).
 * Step 2: show every data_layer-backed editable sublayer in that map
 *         as a check-list; user confirms which ones to add.
 *
 * The walk:
 *   - For each MapLayer in map.data.layers with source.kind ===
 *     'data-layer', fetch that data_layer item.
 *   - For each editable v3 sublayer (editingEnabled !== false), emit
 *     a candidate. Layers backed by v1/v2 inline GeoJSON are skipped
 *     silently (they don't expose per-layer editing controls).
 *   - Already-target sublayers show as disabled+unchecked so users
 *     can't create duplicates; non-editable layers show as disabled
 *     with a "not editable" reason.
 *
 * The MapLayerSource of kind data-layer carries only itemId, not a
 * specific sublayer key. So a v3 data_layer with N sublayers
 * contributes N candidates (deduped against existingTargets). That's
 * intentional: the bulk-import means "import everything editable
 * the map references", and the user trims after.
 */
export function AddFromMapDialog({
  open,
  onClose,
  existingTargets,
  defaultMapId,
  onAdd,
}: Props) {
  // The map we're importing from. Holds the FULL Item (data + layers)
  // because we need its layers list. Reset when the dialog closes.
  const [map, setMap] = useState<Item | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // When the dialog opens, decide step 1 vs step 2:
  //   - If defaultMapId is set, fetch that map and skip the picker.
  //   - Otherwise open the picker right away.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setMap(null);
    setCandidates(null);
    setPicked(new Set());
    if (defaultMapId) {
      void loadMap(defaultMapId);
    } else {
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultMapId]);

  async function loadMap(mapId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${mapId}`);
      if (!res.ok) {
        setError(`Couldn't load map: ${res.status}`);
        return;
      }
      const item = (await res.json()) as Item;
      setMap(item);
      await buildCandidates(item);
    } finally {
      setLoading(false);
    }
  }

  // Walk the map's data-layer references and build the candidate
  // list. Each unique data_layer is fetched once; its v3 sublayers
  // become candidates. Failures fall through to a banner so the
  // user can still confirm whatever did load.
  async function buildCandidates(mapItem: Item) {
    const data = mapItem.data as MapData | undefined;
    if (!data) {
      setCandidates([]);
      return;
    }
    const refIds = Array.from(
      new Set(
        (data.layers ?? [])
          .filter((l) => l.source.kind === 'data-layer')
          .map((l) =>
            l.source.kind === 'data-layer' ? l.source.itemId : '',
          )
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (refIds.length === 0) {
      setCandidates([]);
      return;
    }
    const fetched = await Promise.all(
      refIds.map((id) =>
        fetch(`/api/portal/items/${id}`)
          .then((r) => (r.ok ? (r.json() as Promise<Item>) : null))
          .catch(() => null),
      ),
    );
    const out: Candidate[] = [];
    for (let i = 0; i < refIds.length; i += 1) {
      const dl = fetched[i];
      if (!dl) continue;
      const dlData = dl.data as DataLayerData | undefined;
      if (!dlData || dlData.version !== 3) continue;
      for (const sub of dlData.layers) {
        const key = `${dl.id}:${sub.id}`;
        out.push({
          key,
          dataLayerId: dl.id,
          dataLayerTitle: dl.title,
          layer: sub,
          alreadyTarget: existingTargets.has(key),
          notEditable: sub.editingEnabled === false,
        });
      }
    }
    setCandidates(out);
    // Default-check everything that's both editable and not already
    // a target. Users can untick anything they don't want.
    const initial = new Set<string>();
    for (const c of out) {
      if (!c.alreadyTarget && !c.notEditable) initial.add(c.key);
    }
    setPicked(initial);
  }

  function toggle(key: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    if (!candidates) return;
    setPicked(
      new Set(
        candidates
          .filter((c) => !c.alreadyTarget && !c.notEditable)
          .map((c) => c.key),
      ),
    );
  }

  function selectNone() {
    setPicked(new Set());
  }

  function confirm() {
    if (!candidates) return;
    const out = candidates
      .filter((c) => picked.has(c.key))
      .map((c) => ({
        dataLayerId: c.dataLayerId,
        layerKey: c.layer.id,
        layer: c.layer,
        dataLayerTitle: c.dataLayerTitle,
      }));
    onAdd(out);
    handleClose();
  }

  function handleClose() {
    setMap(null);
    setCandidates(null);
    setPicked(new Set());
    setPickerOpen(false);
    setError(null);
    onClose();
  }

  const eligibleCount = useMemo(
    () =>
      candidates?.filter((c) => !c.alreadyTarget && !c.notEditable).length ?? 0,
    [candidates],
  );

  if (!open) return null;

  // Step 1: picker open. The picker overlays itself on top of any
  // current dialog state so we don't need a wrapping shell here.
  if (pickerOpen) {
    return (
      <PickMapDialog
        open
        onClose={() => {
          setPickerOpen(false);
          // If we never got a map and the user cancelled, exit
          // entirely instead of stranding them on an empty step 2.
          if (!map) handleClose();
        }}
        onPick={(picked) => {
          setPickerOpen(false);
          void loadMap(picked.id);
        }}
        title="Pick a map to import from"
        subtitle="We'll list every editable layer in this map so you can pick which to expose."
      />
    );
  }

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
              {map ? `Add layers from "${map.title}"` : 'Add from map'}
            </h2>
            <p className="text-xs text-muted">
              {map
                ? 'Each picked layer becomes an editor target with default policies. Tweak after import.'
                : 'Choose a map; we\'ll surface its editable layers as targets to import.'}
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

        <div className="flex-1 overflow-auto">
          {loading || candidates === null ? (
            <div className="flex items-center justify-center px-4 py-8 text-sm text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Walking map layers...
            </div>
          ) : candidates.length === 0 ? (
            <div className="px-4 py-6 text-sm">
              <p className="text-ink-1">
                This map doesn't reference any data layer items.
              </p>
              <p className="mt-2 text-xs text-muted">
                Editor targets need data_layer-backed layers; URL-based
                or external services aren't writable through the editor
                runtime. Add a data layer to the map first, or pick
                targets one at a time with "Add target".
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2 text-xs">
                <span className="text-muted">
                  {eligibleCount} eligible layer
                  {eligibleCount === 1 ? '' : 's'}{' '}
                  ({picked.size} selected)
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-muted hover:text-accent"
                  >
                    Select all
                  </button>
                  <span className="text-muted">/</span>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="text-muted hover:text-accent"
                  >
                    Select none
                  </button>
                </div>
              </div>
              <ul className="divide-y divide-border">
                {candidates.map((c) => {
                  const checkable = !c.alreadyTarget && !c.notEditable;
                  const isOn = picked.has(c.key);
                  return (
                    <li
                      key={c.key}
                      className={`flex items-start gap-3 px-4 py-3 ${
                        checkable ? '' : 'opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isOn}
                        disabled={!checkable}
                        onChange={() => toggle(c.key)}
                        className="mt-1 h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
                        aria-label={`Import ${c.dataLayerTitle} / ${c.layer.label}`}
                      />
                      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink-0">
                            {c.dataLayerTitle}
                          </span>
                          <span className="text-muted">/</span>
                          <span className="truncate text-sm text-ink-1">
                            {c.layer.label}
                          </span>
                          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                            {c.layer.geometryType ?? 'table'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {c.layer.fields.length} field
                          {c.layer.fields.length === 1 ? '' : 's'}
                          {c.alreadyTarget ? ' / already a target' : ''}
                          {c.notEditable
                            ? ' / editing disabled on layer'
                            : ''}
                          {c.layer.editingPolicy === 'own-rows-only'
                            ? ' / own-rows policy'
                            : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {error ? (
            <p className="px-4 py-2 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-sm text-muted hover:text-ink-0"
          >
            Pick a different map
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={picked.size === 0}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Add {picked.size > 0 ? picked.size : ''} target
              {picked.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
