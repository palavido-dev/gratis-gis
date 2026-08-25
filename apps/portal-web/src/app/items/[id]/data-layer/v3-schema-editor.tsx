// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus, Save, X } from 'lucide-react';
import type {
  DataLayerDataV3,
  DataLayerSublayer,
  FeatureField,
} from '@gratis-gis/shared-types';
import { DataLayerBuilder } from '@/app/items/new/data-layer-builder';
import { useT } from '@/lib/i18n/locale-context';
import { useV3Editor } from './v3-editor-context';
import { V3LayerDataPanel } from './v3-layer-data-panel';

/**
 * Detail-page editing surfaces for v3 data_layer items, split across
 * two tabs (#73):
 *
 * - V3DataSection (Data tab): per-layer import, browse, analyze.
 * - V3StructureSection (Structure tab): the multi-layer builder the
 *   /items/new wizard uses, pre-filled with the item's current v3
 *   config, plus the event-layer wizard and the save button.
 *
 * Both read the same draft from V3EditorScope (see
 * v3-editor-context.tsx), so a layer added in the builder shows up
 * in the Data tab's picker before it is saved, exactly as it did
 * when the two lived in one column.
 *
 * Persistence: a save takes effect immediately. Since the
 * observation-log pivot a schema edit is pure metadata, because
 * features are keyed by scope rather than living in per-layer tables
 * with columns to alter. There is no DDL to run and no data to lose.
 *
 * This used to say the opposite, that saves were stored opaquely and
 * would not reshape anything "until Phase C lands". Phase C was made
 * unnecessary by the engine substrate rather than completed, and the
 * note survived. See ItemsService for the authoritative version.
 */

/** Data tab: work with the rows of whichever layer you pick. */
export function V3DataSection({
  itemId,
  canEdit,
  canDownload,
}: {
  itemId: string;
  canEdit: boolean;
  /** Download tier (#32), resolved server-side by the detail page.
   *  Gates the export affordances down in the feature browser. */
  canDownload: boolean;
}) {
  const { data } = useV3Editor();
  return (
    <V3LayerDataPanel
      itemId={itemId}
      layers={data.layers}
      canEdit={canEdit}
      canDownload={canDownload}
    />
  );
}

/** Structure tab: schema builder, event-layer wizard, save. */
export function V3StructureSection({
  itemId,
  canEdit,
}: {
  itemId: string;
  canEdit: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const { data, setData, initial } = useV3Editor();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Simple dirty check. Reference inequality is fine here: the builder
  // replaces the whole value on every edit, so `data !== initial`
  // tracks any mutation the user has made.
  const dirty = data !== initial;

  async function save() {
    setError(null);

    // Re-run the same lightweight validation the wizard does so the
    // user gets the same error surface regardless of entry point.
    const labelMissing = data.layers.find(
      (l) => !l.label.trim() || !l.name.trim(),
    );
    if (labelMissing) {
      setError('Every layer needs a label and a table name.');
      return;
    }
    for (const layer of data.layers) {
      const names = layer.fields.map((f) => f.name).filter(Boolean);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        setError(
          `Layer "${layer.label}" has duplicate field name(s): ${[
            ...new Set(dupes),
          ].join(', ')}.`,
        );
        return;
      }
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // router.refresh re-pulls the server-rendered item so the header
      // stats (layer counts, timestamps) reflect the updated schema.
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-1">
        <p className="font-medium">{t('v3Editor.structureTitle')}</p>
        <p className="mt-0.5 text-muted">{t('v3Editor.structureIntro')}</p>
      </div>

      {/* Quick wizard for the most common related-table pattern: the
          author has a parent feature (poles, parcels, transect points,
          buildings, etc.) and wants to capture per-event metadata
          alongside the parent (inspections, visits, observations,
          damage entries). #174: replaces the trap of dropping fields
          into a form's attachment group, which doesn't persist.

          Only relevant when there's at least one spatial layer to
          attach events to, and only when the user can edit. */}
      {canEdit && data.layers.some((l) => l.geometryType !== null) ? (
        <EventLayerWizard data={data} onChange={setData} />
      ) : null}

      <fieldset
        disabled={!canEdit}
        className={canEdit ? undefined : 'pointer-events-none opacity-60'}
      >
        <DataLayerBuilder value={data} onChange={setData} />
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save schema
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event-layer wizard (#174)
// ---------------------------------------------------------------------------

/**
 * Quick-add wizard that scaffolds a related event layer in one click.
 * The pattern: parent spatial features (poles, parcels, etc.) with a
 * 1:N attribute-only sublayer for per-event records (inspections,
 * visits, observations, damage entries) that can carry attachments.
 *
 * Replaces the misleading "drop questions into an attachment group"
 * affordance from #157 (closed under the #158 design reversal).
 *
 * Implementation note: this just composes a new sublayer client-side
 * and pushes it onto data.layers. The user still clicks "Save schema"
 * to persist. We do NOT call a separate backend endpoint because the
 * existing item PATCH already accepts the whole v3 blob and the
 * server reconciles tables from the schema.
 */
function EventLayerWizard({
  data,
  onChange,
}: {
  data: DataLayerDataV3;
  onChange: (next: DataLayerDataV3) => void;
}) {
  const spatialLayers = data.layers.filter((l) => l.geometryType !== null);
  const [open, setOpen] = useState(false);
  const [parentLayerId, setParentLayerId] = useState(
    spatialLayers[0]?.id ?? '',
  );
  const [label, setLabel] = useState('Inspections');
  const [enableAttachments, setEnableAttachments] = useState(true);

  function reset() {
    setLabel('Inspections');
    setEnableAttachments(true);
    setParentLayerId(spatialLayers[0]?.id ?? '');
  }

  function add() {
    const parent = data.layers.find((l) => l.id === parentLayerId);
    if (!parent) return;
    const trimmedLabel = label.trim() || 'Events';
    // Generate a unique sublayer id and table-friendly name.
    const baseName = trimmedLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'events';
    const existingNames = new Set(data.layers.map((l) => l.name));
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${baseName}_${suffix++}`;
    }
    const newId = `lyr_${Math.random().toString(36).slice(2, 10)}`;
    const fkColumn = `parent_${parent.name}_id`.slice(0, 60);
    const defaultFields: FeatureField[] = [
      {
        name: 'event_date',
        type: 'date',
        label: 'Date',
        nullable: false,
      },
      {
        name: 'notes',
        type: 'string',
        label: 'Notes',
        nullable: true,
      },
    ];
    const newLayer: DataLayerSublayer = {
      id: newId,
      label: trimmedLabel,
      name,
      // Attribute-only related table: no geometry of its own.
      // Photos / events live with the parent feature's location.
      geometryType: null,
      fields: defaultFields,
      editingEnabled: true,
      attachmentsEnabled: enableAttachments,
      parentLayerId: parent.id,
      parentFkColumn: fkColumn,
    };
    onChange({
      ...data,
      layers: [...data.layers, newLayer],
    });
    setOpen(false);
    reset();
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          <Plus className="h-3.5 w-3.5" />
          Add event-tracking layer
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-0">
          Add event-tracking layer
        </h3>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="rounded p-1 text-muted hover:bg-surface-2"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <p className="text-xs text-muted">
        Adds a related attribute-only layer keyed to a parent feature.
        One row per event (inspection, visit, observation, damage
        entry, etc.); photos can be attached to each event row instead
        of to the parent feature directly.
      </p>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Parent layer
        </label>
        <select
          value={parentLayerId}
          onChange={(e) => setParentLayerId(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          {spatialLayers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label} ({l.geometryType})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="event-layer-label"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          New layer name
        </label>
        <input
          id="event-layer-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Inspections, Visits, Observations..."
          maxLength={120}
          className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          checked={enableAttachments}
          onChange={(e) => setEnableAttachments(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Enable attachments on this layer (recommended for photo
        evidence)
      </label>

      <p className="rounded border border-success/30 bg-success/10 px-2 py-1.5 text-2xs text-success">
        We'll seed two default fields ("Date", "Notes") that you can
        edit in the schema below before saving. The new layer will
        link to the parent via a foreign-key column on save.
      </p>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={add}
          disabled={!parentLayerId || label.trim().length === 0}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add layer
        </button>
      </div>
    </section>
  );
}
