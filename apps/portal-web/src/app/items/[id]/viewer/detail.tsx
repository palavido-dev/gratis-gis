// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  Layers,
  Loader2,
  Map as MapIcon,
  Play,
  Plus,
  Settings,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { BuilderShell } from '@/components/builder-shell/builder-shell';
import Link from 'next/link';
import type {
  DataLayerData,
  DataLayerSublayer,
  Item,
  ViewerData,
  ViewerTarget,
  ViewerTool,
  WebAppData,
} from '@gratis-gis/shared-types';
import { DEFAULT_VIEWER_TOOLS } from '@gratis-gis/shared-types';
import { AddTargetDialog } from '../editor/add-target-dialog';
import { AddFromMapDialog } from '../editor/add-from-map-dialog';
import { PickMapDialog } from '../editor/pick-map-dialog';
import { ConvertToCustomButton } from '../convert-to-custom';

interface Props {
  itemId: string;
  initial: ViewerData;
  canEdit: boolean;
}

/**
 * Viewer item detail page (#259 slice 3).
 *
 * Mirrors EditorDetail's shape but trims the editing-specific knobs:
 * a viewer is read-only by definition, so each target is just an
 * identity reference (dataLayerId + layerKey). No capability flags,
 * no editable-fields multiselect, no row-scope, no templates,
 * no snapping. The remaining authoring surfaces are:
 *
 *   1. Reference map: optional pointer to a `map` item; the runtime
 *      inherits its basemap, viewport, layer order, and reference
 *      symbology. Same picker the EditorDetail uses (PickMapDialog
 *      is reused as-is).
 *
 *   2. Target layers: which v3 data_layer sublayers this viewer
 *      exposes. Reuses EditorDetail's AddTargetDialog with
 *      `allowNonEditable` flipped on, since a viewer that's purely
 *      reading shouldn't be blocked by an editing toggle on the
 *      data_layer.
 *
 *   3. Tool palette: subset of the read-side toolbar
 *      (select / query / measure / attribute-table / legend / print).
 *      Authors trim to a narrower app if the workflow doesn't need
 *      all six. Print is the new tool for #259; everything else is
 *      already implemented in the runtime.
 *
 * Persistence: PATCH /api/portal/items/<id> with `{ data: viewer }`.
 * Same shape and dirty/save flow as MapEditor and EditorDetail.
 */
export function ViewerDetail({ itemId, initial, canEdit }: Props) {
  // Working copy. Seed `tools` from the default palette when the
  // persisted item is older than the tools field landing (matches
  // EditorDetail's pattern).
  const [viewer, setViewer] = useState<ViewerData>(() => ({
    ...initial,
    tools:
      initial.tools && initial.tools.length > 0
        ? initial.tools
        : DEFAULT_VIEWER_TOOLS,
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingFromMap, setAddingFromMap] = useState(false);
  const [pickingMap, setPickingMap] = useState(false);

  // Resolved title for the referenced map. Looked up by id so a
  // rename of the map flows through automatically.
  const [mapTitle, setMapTitle] = useState<string | null>(null);
  const [mapMissing, setMapMissing] = useState(false);
  useEffect(() => {
    if (!viewer.mapId) {
      setMapTitle(null);
      setMapMissing(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${viewer.mapId}`);
        if (cancelled) return;
        if (!res.ok) {
          setMapTitle(null);
          setMapMissing(true);
          return;
        }
        const item = (await res.json()) as Item;
        setMapTitle(item.title);
        setMapMissing(false);
      } catch {
        if (!cancelled) {
          setMapTitle(null);
          setMapMissing(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewer.mapId]);

  // Resolved (item, sublayer) per target. Populates target rows with
  // titles + geometry pills + warnings when a target points at a
  // deleted or renamed layer.
  const [resolved, setResolved] = useState<
    Record<string, { item: Item; layer: DataLayerSublayer | null }>
  >({});
  const [resolving, setResolving] = useState(false);
  const resolveSeqRef = useRef(0);

  useEffect(() => {
    const ids = Array.from(new Set(viewer.targets.map((t) => t.dataLayerId)));
    if (ids.length === 0) {
      setResolved({});
      return;
    }
    const seq = ++resolveSeqRef.current;
    setResolving(true);
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          ids.map((id) =>
            fetch(`/api/portal/items/${id}`)
              .then((r) => (r.ok ? (r.json() as Promise<Item>) : null))
              .catch(() => null),
          ),
        );
        if (cancelled || resolveSeqRef.current !== seq) return;
        const byId = new Map<string, Item>();
        for (let i = 0; i < ids.length; i += 1) {
          const it = results[i];
          if (it) byId.set(ids[i]!, it);
        }
        const next: Record<string, { item: Item; layer: DataLayerSublayer | null }> = {};
        for (const t of viewer.targets) {
          const key = `${t.dataLayerId}:${t.layerKey}`;
          const item = byId.get(t.dataLayerId);
          if (!item) continue;
          const data = item.data as DataLayerData | undefined;
          const layer =
            data && data.version === 3
              ? (data.layers.find((l) => l.id === t.layerKey) ?? null)
              : null;
          next[key] = { item, layer };
        }
        setResolved(next);
      } finally {
        if (!cancelled && resolveSeqRef.current === seq) setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewer.targets]);

  // Browser nag on unsaved changes. Same pattern as MapEditor /
  // EditorDetail.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaved(false);
  }, []);

  function removeTarget(index: number) {
    setViewer((cur) => ({
      ...cur,
      targets: cur.targets.filter((_, i) => i !== index),
    }));
    markDirty();
  }

  function addTarget(input: {
    dataLayerId: string;
    layerKey: string;
    layer: DataLayerSublayer;
    dataLayerTitle: string;
  }) {
    const target: ViewerTarget = {
      dataLayerId: input.dataLayerId,
      layerKey: input.layerKey,
    };
    setViewer((cur) => ({ ...cur, targets: [...cur.targets, target] }));
    // Pre-seed the resolved cache so the new card paints
    // immediately without waiting for the metadata refetch.
    setResolved((cur) => ({
      ...cur,
      [`${input.dataLayerId}:${input.layerKey}`]: {
        item: {
          id: input.dataLayerId,
          title: input.dataLayerTitle,
        } as unknown as Item,
        layer: input.layer,
      },
    }));
    markDirty();
  }

  /**
   * Bulk add from the AddFromMapDialog (#259 slice 4b). The dialog
   * has already deduped against existingTargets, but we still
   * filter defensively here to dodge any race where the dialog's
   * snapshot is older than this state. Each addition becomes a
   * minimal ViewerTarget (just the identity pair) -- a viewer has
   * no per-target capabilities to seed, unlike the editor's
   * bulkAddFromMap.
   */
  function bulkAddFromMap(
    additions: Array<{
      dataLayerId: string;
      layerKey: string;
      layer: DataLayerSublayer;
      dataLayerTitle: string;
    }>,
  ) {
    if (additions.length === 0) return;
    const seen = new Set(
      viewer.targets.map((t) => `${t.dataLayerId}:${t.layerKey}`),
    );
    const newTargets: ViewerTarget[] = [];
    const newResolved: typeof resolved = { ...resolved };
    for (const a of additions) {
      const key = `${a.dataLayerId}:${a.layerKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newTargets.push({
        dataLayerId: a.dataLayerId,
        layerKey: a.layerKey,
      });
      newResolved[key] = {
        item: {
          id: a.dataLayerId,
          title: a.dataLayerTitle,
        } as unknown as Item,
        layer: a.layer,
      };
    }
    if (newTargets.length === 0) return;
    setViewer((cur) => ({ ...cur, targets: [...cur.targets, ...newTargets] }));
    setResolved(newResolved);
    markDirty();
  }

  function pickMap(mapId: string | null) {
    setViewer((cur) => {
      const next = { ...cur };
      if (mapId === null) delete next.mapId;
      else next.mapId = mapId;
      return next;
    });
    markDirty();
  }

  function toggleTool(tool: ViewerTool, on: boolean) {
    setViewer((cur) => {
      const set = new Set(cur.tools);
      if (on) set.add(tool);
      else set.delete(tool);
      return { ...cur, tools: Array.from(set) };
    });
    markDirty();
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // Wrap in the canonical WebAppData shape before PATCHing. The
      // API replaces data_json wholesale, so sending the raw
      // ViewerData would strip the `template` + `config` keys that
      // isViewerItem / readViewerData rely on; the next runtime load
      // would 404 because the type guard no longer recognizes the
      // item as a viewer. See packages/shared-types/src/web-app.ts.
      const payload: WebAppData = {
        version: 1,
        template: 'viewer',
        config: { template: 'viewer', viewer },
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setViewer({
      ...initial,
      tools:
        initial.tools && initial.tools.length > 0
          ? initial.tools
          : DEFAULT_VIEWER_TOOLS,
    });
    setDirty(false);
    setError(null);
  }

  const existingKeys = useMemo(
    () => new Set(viewer.targets.map((t) => `${t.dataLayerId}:${t.layerKey}`)),
    [viewer.targets],
  );

  // #17 -- toolbar lives in BuilderShell's toolbarRight slot now,
  // not as a sticky section above the form.  Builder chrome (back
  // arrow, title) comes from BuilderShell; we just provide the
  // action buttons + dirty / saved indicators.  Same set of
  // actions as the legacy save bar (Open viewer + Convert to
  // custom + Discard + Save), so the migration is layout-only.
  const toolbarRight = (
    <div className="flex items-center gap-2">
      {canEdit && dirty ? (
        <span className="rounded-full bg-warn/15 px-2 py-0.5 text-2xs font-medium text-warn">
          Unsaved changes
        </span>
      ) : canEdit && saved ? (
        <span className="text-2xs text-success">Saved</span>
      ) : null}
      <a
        href={`/items/${itemId}/viewer/run`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
        title="Open this viewer in a new tab"
      >
        <Play className="h-3.5 w-3.5" />
        Open viewer
      </a>
      {canEdit ? (
        <>
          <ConvertToCustomButton
            itemId={itemId}
            sourceTemplate="viewer"
            {...(viewer.mapId ? { sourceMapId: viewer.mapId } : {})}
            sourceTargets={viewer.targets}
          />
          <button
            type="button"
            onClick={cancel}
            disabled={!dirty || saving}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
        </>
      ) : null}
    </div>
  );

  // Left rail = the editable layers list.  This is the primary
  // content surface for a viewer (every other config is downstream
  // of "what layers does the viewer expose").
  const layersPanel = (
    <div className="space-y-3 p-3">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAddingFromMap(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs font-medium hover:bg-surface-2"
            title="Bulk-import layers from a map"
          >
            <MapIcon className="h-3.5 w-3.5" />
            Add from map
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs font-medium hover:bg-surface-2"
          >
            <Plus className="h-3.5 w-3.5" />
            Add layer
          </button>
        </div>
      ) : null}
      <p className="text-2xs text-muted">
        Layers exposed in the layer panel, legend, and attribute
        table. Symbology comes from the underlying data layer.
      </p>
      {viewer.targets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
          No layers yet.
          {canEdit ? ' Use "Add layer" above.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface-0">
          {viewer.targets.map((target, index) => (
            <TargetRow
              key={`${target.dataLayerId}:${target.layerKey}`}
              target={target}
              resolved={
                resolved[`${target.dataLayerId}:${target.layerKey}`] ?? null
              }
              resolving={resolving}
              canEdit={canEdit}
              onRemove={() => removeTarget(index)}
            />
          ))}
        </ul>
      )}
    </div>
  );

  // Right rail = secondary config (reference map + tool palette).
  // Both are "set it once and forget it" knobs that don't warrant
  // taking room from the primary layers list.
  const settingsPanel = (
    <div className="space-y-4 p-3">
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <MapIcon className="h-3.5 w-3.5" />
          Reference map
        </h3>
        <p className="text-2xs text-muted">
          The viewer opens against this map's basemap, viewport, and
          layer order. Layers in the map that are not viewer targets
          render as read-only reference context.
        </p>
        {viewer.mapId ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border bg-surface-0 px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <MapIcon className="h-3.5 w-3.5 shrink-0 text-success" />
              <span className="truncate text-xs font-medium text-ink-0">
                {mapTitle ?? <span className="text-muted">Loading...</span>}
              </span>
              {mapMissing ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-2xs font-medium text-warn">
                  <AlertTriangle className="h-3 w-3" />
                  Missing
                </span>
              ) : null}
              {!mapMissing && mapTitle ? (
                <Link
                  href={`/items/${viewer.mapId}`}
                  className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted hover:text-accent"
                >
                  <ExternalLink className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
            {canEdit ? (
              <button
                type="button"
                onClick={() => pickMap(null)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger"
                aria-label="Clear reference map"
                title="Clear reference map"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 rounded-md border border-dashed border-border px-2 py-2 text-2xs text-muted">
            No reference map.
            {canEdit
              ? ' Without one, the viewer opens on a default basemap.'
              : ''}
          </p>
        )}
        {canEdit ? (
          <button
            type="button"
            onClick={() => setPickingMap(true)}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs font-medium hover:bg-surface-2"
          >
            {viewer.mapId ? 'Change map' : 'Pick map'}
          </button>
        ) : null}
      </section>
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <Wrench className="h-3.5 w-3.5" />
          Toolbar
        </h3>
        <p className="text-2xs text-muted">
          Read-side tools the viewer exposes. Every tool here is
          non-destructive.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2">
          {ALL_TOOLS.map(({ key, label, hint }) => {
            const on = viewer.tools.includes(key);
            return (
              <label
                key={key}
                className="flex items-start gap-2 text-xs"
                title={hint}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!canEdit}
                  onChange={(e) => toggleTool(key, e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer"
                />
                <span>
                  <span className="font-medium text-ink-1">{label}</span>
                  <span className="block text-2xs text-muted">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );

  return (
    <>
      <BuilderShell
        storageKey="builder-shell:viewer"
        backHref={`/items/${itemId}`}
        title="Viewer configuration"
        icon={<Eye className="h-4 w-4 text-purple-600 dark:text-purple-400" />}
        toolbarRight={toolbarRight}
        leftPanel={layersPanel}
        leftPanelTitle="Layers"
        leftRailIcon={<Layers className="h-4 w-4" />}
        rightPanel={settingsPanel}
        rightPanelTitle="Settings"
        rightRailIcon={<Settings className="h-4 w-4" />}
      >
        {/* Center pane: error banner + "what is this builder" note.
            A viewer doesn't have a designer canvas the way a Custom
            Web App does -- its surface is the runtime page at
            /viewer/run, opened in a new tab via the toolbar.  The
            center pane gives the author orientation + room for
            future inline preview / live-render. */}
        <div className="absolute inset-0 flex flex-col gap-4 overflow-auto p-6">
          {error ? (
            <div
              className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {error}
            </div>
          ) : null}
          <div className="mx-auto max-w-2xl rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center">
            <Eye className="mx-auto h-8 w-8 text-purple-300" />
            <h2 className="mt-2 text-sm font-semibold text-ink-0">
              Viewer configuration
            </h2>
            <p className="mt-1 text-xs text-muted">
              Add layers in the left panel, pick a reference map and
              toolbar tools on the right. Open the viewer to test the
              live runtime in a new tab.
            </p>
            <a
              href={`/items/${itemId}/viewer/run`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <Play className="h-3.5 w-3.5" />
              Open viewer in a new tab
            </a>
          </div>
        </div>
      </BuilderShell>

      {/* Dialogs live outside BuilderShell so they portal above the
          shell's panel chrome.  Add target / add from map / pick map
          are reused as-is from the legacy layout. */}
      <AddTargetDialog
        open={adding}
        onClose={() => setAdding(false)}
        existingTargets={existingKeys}
        allowNonEditable
        onAdd={addTarget}
      />

      <AddFromMapDialog
        open={addingFromMap}
        onClose={() => setAddingFromMap(false)}
        existingTargets={existingKeys}
        defaultMapId={viewer.mapId}
        allowNonEditable
        onAdd={bulkAddFromMap}
      />

      <PickMapDialog
        open={pickingMap}
        onClose={() => setPickingMap(false)}
        onPick={(m) => pickMap(m.id)}
      />
    </>
  );
}

const ALL_TOOLS: Array<{ key: ViewerTool; label: string; hint: string }> = [
  { key: 'select', label: 'Select', hint: 'Pick features to inspect.' },
  {
    key: 'query',
    label: 'Query',
    hint: 'Filter visible features by attribute or extent.',
  },
  {
    key: 'measure',
    label: 'Measure',
    hint: 'Distance and area readouts on the canvas.',
  },
  {
    key: 'attribute-table',
    label: 'Attribute table',
    hint: 'Browse layer rows in a sortable table.',
  },
  { key: 'legend', label: 'Legend', hint: 'Symbology key for the visible layers.' },
  {
    key: 'print',
    label: 'Print',
    hint: 'Export the current view as a printable layout.',
  },
];

interface TargetRowProps {
  target: ViewerTarget;
  resolved: { item: Item; layer: DataLayerSublayer | null } | null;
  resolving: boolean;
  canEdit: boolean;
  onRemove: () => void;
}

/**
 * One viewer target. Renders the resolved data layer + sublayer
 * label, geometry-type pill, and a remove button. When the layer
 * can't be resolved the row surfaces a warning so the user knows
 * the target is broken (item deleted, layer key renamed, etc.).
 */
function TargetRow({ target, resolved, resolving, canEdit, onRemove }: TargetRowProps) {
  const layer = resolved?.layer ?? null;
  const item = resolved?.item ?? null;
  const broken = resolved !== null && layer === null;

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink-0">
            {item?.title ?? (
              <span className="text-muted">
                {resolving ? 'Loading...' : target.dataLayerId.slice(0, 8)}
              </span>
            )}
          </span>
          <span className="text-muted">/</span>
          <span className="text-sm text-ink-1">
            {layer?.label ?? target.layerKey}
          </span>
          {layer?.geometryType ? (
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
              {layer.geometryType}
            </span>
          ) : null}
        </div>
        {item ? (
          <Link
            href={`/items/${item.id}`}
            className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            Open data layer <ExternalLink className="h-3 w-3" />
          </Link>
        ) : null}
        {broken ? (
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-warn">
            <AlertTriangle className="h-3.5 w-3.5" />
            The referenced layer could not be loaded. It may have been
            deleted or renamed.
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-danger"
          aria-label="Remove layer"
          title="Remove layer"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </li>
  );
}
