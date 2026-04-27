'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  PencilRuler,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import type {
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  EditorTool,
  Item,
} from '@gratis-gis/shared-types';
import { DEFAULT_EDITOR_TOOLS } from '@gratis-gis/shared-types';
import { AddTargetDialog } from './add-target-dialog';

interface Props {
  itemId: string;
  initial: EditorData;
  canEdit: boolean;
}

/**
 * Editor item detail page (slice 2).
 *
 * Lets the owner / admin pick which data_layer sublayers this Editor
 * exposes, configure per-layer capabilities (create / edit-geometry /
 * edit-attributes / delete + editable fields + row scope), pick the
 * tool palette, and tweak snap settings.
 *
 * Authorization is conjunctive (see docs/editing-and-collection.md):
 * this UI can NARROW from what the underlying data_layer's
 * `editingEnabled` + `editingPolicy` allows, but never widen. The
 * runtime (slice 3) re-checks at request time so a stale config that
 * lists a now-disabled layer fails closed.
 *
 * Persistence: PATCH /api/portal/items/<id> with `{ data: editorData }`.
 * Same shape and dirty/save flow used by every other detail editor
 * (map-editor, geo-boundary-editor, folder-detail).
 *
 * Slice 3 will add:
 *   - Map-reference picker (mapId) so the runtime can inherit a
 *     basemap + viewport from a chosen Map item.
 *   - Feature template authoring per target.
 *   - The actual editing canvas runtime.
 */
export function EditorDetail({ itemId, initial, canEdit }: Props) {
  // The working copy. We seed `tools` from the default palette when
  // the persisted shape is older than slice 1 and missing the
  // field, so users on legacy items see something instead of an
  // empty palette.
  const [editor, setEditor] = useState<EditorData>(() => ({
    ...initial,
    tools:
      initial.tools && initial.tools.length > 0
        ? initial.tools
        : DEFAULT_EDITOR_TOOLS,
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Cache of resolved (item, sublayer) per target. Lets us render
  // human-readable names + warn when a target points at a layer
  // that has been deleted, renamed, or had editing turned off.
  // Keyed by `<dataLayerId>:<layerKey>`.
  const [resolved, setResolved] = useState<
    Record<string, { item: Item; layer: DataLayerSublayer | null }>
  >({});
  const [resolving, setResolving] = useState(false);
  const resolveSeqRef = useRef(0);

  // Re-resolve metadata whenever the targets list changes ids.
  // Fetches each unique data_layer in parallel and indexes the
  // matched sublayer per target. Failures fall through to a
  // "couldn't load" warning row in the UI.
  useEffect(() => {
    const ids = Array.from(new Set(editor.targets.map((t) => t.dataLayerId)));
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
        for (const t of editor.targets) {
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
  }, [editor.targets]);

  // Browser nag on unsaved changes. Same pattern as MapEditor.
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

  function patchTarget(index: number, updater: (t: EditorTarget) => EditorTarget) {
    setEditor((cur) => ({
      ...cur,
      targets: cur.targets.map((t, i) => (i === index ? updater(t) : t)),
    }));
    markDirty();
  }

  function removeTarget(index: number) {
    setEditor((cur) => ({
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
    // Sensible defaults derived from the picked layer:
    //   - canCreate / delete / edit-attributes / edit-geometry default
    //     to true (geometry only when the layer has a geometry type;
    //     attribute-only related tables default canEditGeometry=false)
    //   - editableFields starts as null = "all schema-editable fields"
    //   - rowScope respects the layer's editingPolicy: own-rows-only
    //     forces 'own' here so the picker reflects the binding
    //     contract; the runtime would re-enforce server-side anyway.
    const target: EditorTarget = {
      dataLayerId: input.dataLayerId,
      layerKey: input.layerKey,
      canCreate: true,
      canEditGeometry: input.layer.geometryType !== null,
      canEditAttributes: true,
      canDelete: true,
      editableFields: null,
      rowScope: input.layer.editingPolicy === 'own-rows-only' ? 'own' : 'all',
      templates: [],
    };
    setEditor((cur) => ({ ...cur, targets: [...cur.targets, target] }));
    // Pre-seed the resolved cache so the new card paints immediately
    // without waiting for the metadata refetch.
    setResolved((cur) => ({
      ...cur,
      [`${input.dataLayerId}:${input.layerKey}`]: {
        item: {
          id: input.dataLayerId,
          title: input.dataLayerTitle,
          // Synthesized minimum: only the fields the card touches
          // are populated. Real values land on the next resolve
          // pass.
        } as unknown as Item,
        layer: input.layer,
      },
    }));
    markDirty();
  }

  function toggleTool(tool: EditorTool, on: boolean) {
    setEditor((cur) => {
      const set = new Set(cur.tools);
      if (on) set.add(tool);
      else set.delete(tool);
      return { ...cur, tools: Array.from(set) };
    });
    markDirty();
  }

  function patchSnapping(patch: Partial<EditorData['snapping']>) {
    setEditor((cur) => ({ ...cur, snapping: { ...cur.snapping, ...patch } }));
    markDirty();
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: editor }),
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
    setEditor({
      ...initial,
      tools:
        initial.tools && initial.tools.length > 0
          ? initial.tools
          : DEFAULT_EDITOR_TOOLS,
    });
    setDirty(false);
    setError(null);
  }

  const existingKeys = useMemo(
    () => new Set(editor.targets.map((t) => `${t.dataLayerId}:${t.layerKey}`)),
    [editor.targets],
  );

  return (
    <div className="space-y-6">
      {/* Sticky save bar mirrors map-editor's UX: present whenever
          dirty so the user always knows how to commit. */}
      {canEdit ? (
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-md border border-border bg-surface-1 px-4 py-2 shadow-sm">
          <div className="flex items-center gap-2 text-sm">
            <PencilRuler className="h-4 w-4 text-purple-600" />
            <span className="font-medium text-ink-0">Editor configuration</span>
            {dirty ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                Unsaved changes
              </span>
            ) : saved ? (
              <span className="text-[11px] text-emerald-700">Saved</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}

      {/* Targets section. Each card is the per-layer policy editor. */}
      <section className="rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-0">
              Target layers
            </h2>
            <p className="text-xs text-muted">
              Layers exposed for editing in this app. Each target narrows from
              what the underlying data layer allows in principle.
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <Plus className="h-3.5 w-3.5" />
              Add target
            </button>
          ) : null}
        </div>
        {editor.targets.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">
            No target layers yet.
            {canEdit ? ' Use "Add target" to expose a data layer here.' : ''}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {editor.targets.map((target, index) => (
              <TargetRow
                key={`${target.dataLayerId}:${target.layerKey}`}
                target={target}
                resolved={
                  resolved[`${target.dataLayerId}:${target.layerKey}`] ?? null
                }
                resolving={resolving}
                canEdit={canEdit}
                onPatch={(updater) => patchTarget(index, updater)}
                onRemove={() => removeTarget(index)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Tool palette toggles. Editing tools that the runtime
          surfaces in slice 3. We render every known tool so the
          author sees the full menu, even if they then disable a
          subset for a narrower workflow. */}
      <section className="rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-0">
            <Wrench className="h-4 w-4 text-muted" />
            Tool palette
          </h2>
          <p className="text-xs text-muted">
            Which editing tools the runtime exposes. The full set covers
            most workflows; trim it for purpose-built editors.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-4">
          {ALL_TOOLS.map(({ key, label, hint }) => {
            const on = editor.tools.includes(key);
            return (
              <label
                key={key}
                className="flex items-start gap-2 text-sm"
                title={hint}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!canEdit}
                  onChange={(e) => toggleTool(key, e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer"
                />
                <span>
                  <span className="font-medium text-ink-1">{label}</span>
                  <span className="block text-[11px] text-muted">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Snapping. tolerancePx is in screen pixels rather than map
          units so behavior stays consistent across zooms. */}
      <section className="rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-0">Snapping</h2>
          <p className="text-xs text-muted">
            Snap-to-vertex behavior shared across drawing tools.
          </p>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={editor.snapping.enabled}
              disabled={!canEdit}
              onChange={(e) => patchSnapping({ enabled: e.target.checked })}
              className="h-4 w-4 cursor-pointer"
            />
            <span>Enable snap</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={editor.snapping.selfSnap}
              disabled={!canEdit || !editor.snapping.enabled}
              onChange={(e) => patchSnapping({ selfSnap: e.target.checked })}
              className="h-4 w-4 cursor-pointer disabled:opacity-50"
            />
            <span className="text-ink-1">
              Self-snap only{' '}
              <span className="text-[11px] text-muted">
                (snap only to vertices in the same layer; otherwise snap to
                anything visible)
              </span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <label htmlFor="snap-tol" className="text-ink-1">
              Tolerance
            </label>
            <input
              id="snap-tol"
              type="range"
              min={2}
              max={30}
              step={1}
              value={editor.snapping.tolerancePx}
              disabled={!canEdit || !editor.snapping.enabled}
              onChange={(e) =>
                patchSnapping({ tolerancePx: Number(e.target.value) })
              }
              className="w-48 cursor-pointer disabled:opacity-50"
            />
            <span className="font-mono text-xs text-muted">
              {editor.snapping.tolerancePx}px
            </span>
          </div>
        </div>
      </section>

      <AddTargetDialog
        open={adding}
        onClose={() => setAdding(false)}
        existingTargets={existingKeys}
        onAdd={addTarget}
      />
    </div>
  );
}

const ALL_TOOLS: Array<{ key: EditorTool; label: string; hint: string }> = [
  { key: 'select', label: 'Select', hint: 'Pick features to inspect or act on.' },
  { key: 'add', label: 'Add', hint: 'Create new features.' },
  { key: 'edit', label: 'Edit', hint: 'Modify geometry or attributes.' },
  { key: 'delete', label: 'Delete', hint: 'Remove features.' },
  { key: 'snap', label: 'Snap toggle', hint: 'Surface a snap on/off button.' },
  { key: 'measure', label: 'Measure', hint: 'Distance and area readouts.' },
  { key: 'undo', label: 'Undo', hint: 'Revert the last edit.' },
  { key: 'redo', label: 'Redo', hint: 'Re-apply a reverted edit.' },
];

interface TargetRowProps {
  target: EditorTarget;
  resolved: { item: Item; layer: DataLayerSublayer | null } | null;
  resolving: boolean;
  canEdit: boolean;
  onPatch: (updater: (t: EditorTarget) => EditorTarget) => void;
  onRemove: () => void;
}

/**
 * One target card. Renders capability checkboxes, fields multi-
 * select (only when canEditAttributes is on), row-scope radio,
 * and a templates placeholder. When the layer can't be resolved
 * (deleted item, renamed layer key, etc.) the card surfaces a
 * warning so the user knows the target is broken.
 */
function TargetRow({
  target,
  resolved,
  resolving,
  canEdit,
  onPatch,
  onRemove,
}: TargetRowProps) {
  const layer = resolved?.layer ?? null;
  const item = resolved?.item ?? null;
  const broken = resolved !== null && layer === null;
  const layerEditable = layer?.editingEnabled !== false;
  const policyForcesOwn = layer?.editingPolicy === 'own-rows-only';

  // Build a stable list of (column name, label) pairs from the
  // resolved layer schema. Empty when the layer is broken or
  // resolving.
  const fields = layer?.fields ?? [];

  // The "all fields editable" case is encoded as null. Switching
  // away from null to an explicit list copies every field name in
  // so the user starts with a known-good baseline.
  const editableSet = useMemo(
    () =>
      target.editableFields === null ? null : new Set(target.editableFields),
    [target.editableFields],
  );

  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink-0">
              {item?.title ?? (
                <span className="text-muted">Loading...</span>
              )}
            </span>
            <span className="text-muted">/</span>
            <span className="text-sm text-ink-1">
              {layer?.label ?? target.layerKey}
            </span>
            {layer?.geometryType ? (
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {layer.geometryType}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            {item ? (
              <Link
                href={`/items/${item.id}`}
                className="inline-flex items-center gap-1 hover:text-accent"
              >
                Open data layer <ExternalLink className="h-3 w-3" />
              </Link>
            ) : null}
            {policyForcesOwn ? (
              <span>Layer policy: own-rows-only</span>
            ) : null}
            {!layerEditable ? (
              <span className="text-amber-700">Editing disabled on layer</span>
            ) : null}
          </div>
          {broken ? (
            <p className="mt-2 inline-flex items-center gap-1 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              The referenced layer could not be loaded. It may have been
              deleted or renamed.
            </p>
          ) : null}
          {!broken && !layerEditable ? (
            <p className="mt-2 text-xs text-amber-800">
              The runtime will block edits on this target until the underlying
              layer's "editing enabled" toggle is on.
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-danger"
            aria-label="Remove target"
            title="Remove target"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Capability checkboxes. canEditGeometry is force-disabled
          for attribute-only related tables (no geometry type).
          rowScope is force-disabled when the layer policy is
          own-rows-only (the radio reflects the binding contract
          rather than letting the user pick a value the runtime
          would refuse). */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CheckboxRow
          label="Create"
          checked={target.canCreate}
          disabled={!canEdit}
          onChange={(v) => onPatch((t) => ({ ...t, canCreate: v }))}
        />
        <CheckboxRow
          label="Edit geometry"
          checked={target.canEditGeometry}
          disabled={!canEdit || layer?.geometryType === null}
          onChange={(v) => onPatch((t) => ({ ...t, canEditGeometry: v }))}
        />
        <CheckboxRow
          label="Edit attributes"
          checked={target.canEditAttributes}
          disabled={!canEdit}
          onChange={(v) => onPatch((t) => ({ ...t, canEditAttributes: v }))}
        />
        <CheckboxRow
          label="Delete"
          checked={target.canDelete}
          disabled={!canEdit}
          onChange={(v) => onPatch((t) => ({ ...t, canDelete: v }))}
        />
      </div>

      {/* Editable fields multi-select. Hidden when canEditAttributes
          is off because it would have no effect. null = all fields,
          [] = no fields, [...] = explicit subset. */}
      {target.canEditAttributes ? (
        <div className="rounded-md border border-border bg-surface-2/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-1">
              Editable fields
            </span>
            <div className="flex gap-2 text-[11px]">
              <button
                type="button"
                disabled={!canEdit || fields.length === 0}
                onClick={() => onPatch((t) => ({ ...t, editableFields: null }))}
                className="text-muted hover:text-accent disabled:opacity-50"
              >
                Allow all
              </button>
              <span className="text-muted">/</span>
              <button
                type="button"
                disabled={!canEdit || fields.length === 0}
                onClick={() =>
                  onPatch((t) => ({ ...t, editableFields: [] }))
                }
                className="text-muted hover:text-accent disabled:opacity-50"
              >
                Allow none
              </button>
            </div>
          </div>
          {fields.length === 0 ? (
            <p className="text-xs text-muted">
              {resolving ? 'Loading fields...' : 'No fields available.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-y-1 sm:grid-cols-3">
              {fields.map((f) => {
                const isOn =
                  editableSet === null ? true : editableSet.has(f.name);
                return (
                  <label
                    key={f.name}
                    className="flex items-center gap-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const next = new Set(
                          editableSet === null
                            ? fields.map((g) => g.name)
                            : editableSet,
                        );
                        if (e.target.checked) next.add(f.name);
                        else next.delete(f.name);
                        // Collapse "every field on" back to null so
                        // subsequent layer-side field additions stay
                        // editable by default. Otherwise keep the
                        // explicit list.
                        const allOn =
                          fields.every((g) => next.has(g.name)) &&
                          fields.length > 0;
                        onPatch((t) => ({
                          ...t,
                          editableFields: allOn ? null : Array.from(next),
                        }));
                      }}
                      className="h-3.5 w-3.5 cursor-pointer"
                    />
                    <span className="truncate" title={f.name}>
                      {f.label || f.name}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {target.editableFields === null ? (
            <p className="mt-2 text-[11px] text-muted">
              All current and future fields editable.
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-muted">
              {target.editableFields.length} of {fields.length} fields editable.
              Future fields default to NOT editable.
            </p>
          )}
        </div>
      ) : null}

      {/* Row scope. own-rows-only at the layer level forces 'own'
          (the radio is locked and reflects the binding). Otherwise
          authors pick. */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-xs font-medium text-ink-1">Row scope</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`scope-${target.dataLayerId}-${target.layerKey}`}
            checked={target.rowScope === 'all'}
            disabled={!canEdit || policyForcesOwn}
            onChange={() => onPatch((t) => ({ ...t, rowScope: 'all' }))}
            className="h-3.5 w-3.5 cursor-pointer"
          />
          All rows the user can see
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`scope-${target.dataLayerId}-${target.layerKey}`}
            checked={target.rowScope === 'own'}
            disabled={!canEdit}
            onChange={() => onPatch((t) => ({ ...t, rowScope: 'own' }))}
            className="h-3.5 w-3.5 cursor-pointer"
          />
          Only rows they authored
        </label>
      </div>

      {/* Templates placeholder. The full template authoring UI lands
          in slice 3 alongside the runtime; for now we just
          indicate the count so authors know it's a real concept
          even when empty. */}
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>
          {target.templates.length} template
          {target.templates.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          disabled
          className="rounded-md border border-border bg-surface-2/60 px-2 py-0.5 opacity-60"
          title="Feature template authoring lands in slice 3."
        >
          Manage templates...
        </button>
      </div>
    </li>
  );
}

interface CheckboxRowProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

function CheckboxRow({ label, checked, disabled, onChange }: CheckboxRowProps) {
  return (
    <label
      className={`flex items-center gap-2 text-sm ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer"
      />
      <span className="text-ink-1">{label}</span>
    </label>
  );
}
