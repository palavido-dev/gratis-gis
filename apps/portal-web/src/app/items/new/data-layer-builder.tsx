// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Circle,
  GripVertical,
  List,
  ListChecks,
  Minus,
  Paperclip,
  Pencil,
  Plus,
  Spline,
  Square,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  UploadProgressPanel,
  uploadWithProgress,
  type UploadBusy,
} from '@/components/upload-progress-panel';
import { CreateSharedPickListDialog } from './create-shared-pick-list-dialog';
import type {
  FeatureField,
  FeatureFieldStorage,
  FeatureFieldType,
  DataLayerDataV3,
  DataLayerSublayer,
  FieldDomain,
  LayerGeometryType,
} from '@gratis-gis/shared-types';

/**
 * Inline builder for multi-layer feature services.
 *
 * Produces a `DataLayerDataV3` that the /items/new wizard POSTs to
 * /api/items at create time. Each layer is either a spatial layer
 * (point/line/polygon) or an attribute-only "table" used for related
 * records. Tables can declare a parent layer + FK column so the
 * relationship is captured at the same time the schema is.
 *
 * Schema edits are pure metadata since the observation-log pivot;
 * for now the v3 blob lands in item.data as-is and the detail page
 * surfaces what's there.
 */
interface Props {
  value: DataLayerDataV3;
  onChange: (next: DataLayerDataV3) => void;
  /**
   * When the user imports a server-staged spatial file (one upload
   * via /ingest/stage), the builder collects per-layer mappings of
   * { layerId -> sourceLayerName } against the returned stagingId so
   * the wizard's Create-item handler can fan out per-layer ingest
   * without re-uploading. Builder state is reset on remount, so the
   * wizard mirrors these into its own state to survive across the
   * Create-item async boundary.
   */
  onPendingFileImport?: (entry: PendingFileImport) => void;
}

const FIELD_TYPE_OPTIONS: Array<{ value: FeatureFieldType; label: string }> = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'date', label: 'Date' },
  // Multi-select stores an array of pick-list codes. A pick list is
  // mandatory to define the legal codes; the wizard auto-prompts for
  // one when this type is chosen via the same coded-value UI that
  // single-select strings use.
  { value: 'multi_select', label: 'Multi-select' },
];

const GEOMETRY_OPTIONS: Array<{
  value: LayerGeometryType;
  label: string;
  Icon: typeof Circle;
  short: string;
}> = [
  { value: 'point', label: 'Point layer', Icon: Circle, short: 'Point' },
  { value: 'line', label: 'Line layer', Icon: Spline, short: 'Line' },
  { value: 'polygon', label: 'Polygon layer', Icon: Square, short: 'Polygon' },
  { value: null, label: 'Table (no geometry)', Icon: Table2, short: 'Table' },
];

function randomId(prefix: string): string {
  // Short opaque ids for layers. Not globally unique, just stable per
  // wizard session: the backend will assign its own uuids when it
  // No DDL runs: features are keyed by scope, not by a per-layer table.
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60) || 'layer'
  );
}

function newLayer(geometryType: LayerGeometryType): DataLayerSublayer {
  const defaultLabel =
    geometryType === null
      ? 'New table'
      : `New ${geometryType} layer`;
  return {
    id: randomId(geometryType === null ? 'tbl' : 'lyr'),
    label: defaultLabel,
    name: slugify(defaultLabel),
    geometryType,
    fields: [],
    editingEnabled: true,
    attachmentsEnabled: false,
  };
}

function newField(): FeatureField {
  return {
    name: '',
    type: 'string',
    label: '',
    nullable: true,
  };
}

export function DataLayerBuilder({
  value,
  onChange,
  onPendingFileImport,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Monotonic counters that LayerCard observes to force-collapse /
  // force-expand. Bumping either causes a single state change in every
  // card simultaneously without lifting their open/closed state up here.
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [expandAllSignal, setExpandAllSignal] = useState(0);

  const layers = value.layers;

  const spatialLayers = useMemo(
    () => layers.filter((l) => l.geometryType !== null),
    [layers],
  );

  const updateLayers = useCallback(
    (nextLayers: DataLayerSublayer[]) => {
      onChange({ ...value, layers: nextLayers });
    },
    [onChange, value],
  );

  const addLayer = useCallback(
    (geometryType: LayerGeometryType) => {
      updateLayers([...layers, newLayer(geometryType)]);
      setAddOpen(false);
    },
    [layers, updateLayers],
  );

  const removeLayer = useCallback(
    (id: string) => {
      // Also clean up any layers that pointed at this one as a parent.
      // With exactOptionalPropertyTypes we can't assign `undefined` to an
      // optional prop: build the cleared copy by destructuring instead.
      const next = layers
        .filter((l) => l.id !== id)
        .map((l) => {
          if (l.parentLayerId !== id) return l;
          const { parentLayerId: _p, parentFkColumn: _fk, ...rest } = l;
          void _p;
          void _fk;
          return rest;
        });
      updateLayers(next);
    },
    [layers, updateLayers],
  );

  const patchLayer = useCallback(
    (id: string, patch: Partial<DataLayerSublayer>) => {
      updateLayers(
        layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      );
    },
    [layers, updateLayers],
  );

  const replaceLayer = useCallback(
    (id: string, next: DataLayerSublayer) => {
      // Full replacement: use this (not patchLayer) when you need to
      // *remove* an optional key like parentLayerId, because the spread
      // in patchLayer would merge it back in from the previous state.
      updateLayers(layers.map((l) => (l.id === id ? next : l)));
    },
    [layers, updateLayers],
  );

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink-0">
            Layers &amp; tables
          </h2>
          <p className="text-xs text-muted">
            Add one or more layers (point, line, polygon) and any related
            tables. You can edit schema, toggle editing/attachments, and
            link tables to a parent layer.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {layers.length > 1 ? (
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => setCollapseAllSignal((v) => v + 1)}
                title="Collapse all layers"
                className="inline-flex h-8 items-center gap-1 bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
              >
                <ChevronUp className="h-3 w-3" />
                Collapse all
              </button>
              <button
                type="button"
                onClick={() => setExpandAllSignal((v) => v + 1)}
                title="Expand all layers"
                className="inline-flex h-8 items-center gap-1 border-l border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
              >
                <ChevronsUpDown className="h-3 w-3" />
                Expand all
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              Add layer
              <ChevronDown className="h-3 w-3" />
            </button>
            {addOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface-1 shadow-card"
              >
                {GEOMETRY_OPTIONS.map(({ value: gt, label, Icon }) => (
                  <button
                    key={String(gt)}
                    type="button"
                    role="menuitem"
                    onClick={() => addLayer(gt)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-1 hover:bg-surface-2"
                  >
                    <Icon className="h-3.5 w-3.5 text-muted" />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {importOpen ? (
        <ImportPanel
          onClose={() => setImportOpen(false)}
          onImport={(imported, pending) => {
            // Append rather than replace: authors can import into an
            // already-seeded builder without losing manually-defined
            // layers.
            updateLayers([...layers, ...imported]);
            // Forward the pending-file-import record (if any) up to
            // the wizard so it can fire per-layer ingest after the
            // item is created. Server-staged uploads always carry a
            // stagingId; client-side GeoJSON parses don't, hence the
            // optionality.
            if (pending && onPendingFileImport) {
              onPendingFileImport(pending);
            }
            setImportOpen(false);
          }}
        />
      ) : null}

      {layers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-0 p-6 text-center text-xs text-muted">
          No layers yet. Click <span className="font-medium">Add layer</span>{' '}
          above to start, or <span className="font-medium">Import</span> from
          a file.
        </div>
      ) : (
        <ul className="space-y-2">
          {layers.map((layer, idx) => (
            <li key={layer.id}>
              <LayerCard
                layer={layer}
                spatialLayers={spatialLayers}
                // Layer rows start collapsed regardless of count. A
                // 1.4M-feature parcel layer with 19 fields renders
                // a giant scroll if it's open by default; the user
                // explicitly expands the layer they want to edit.
                // Matches the Schema / Version History accordion
                // pattern elsewhere on the page.
                initialOpen={false}
                // idx is unused now but keep the var to avoid a
                // map-arg-rename diff when we wire something else
                // here (drag handle, focus management) later.
                {...(idx >= 0 ? {} : {})}
                collapseSignal={collapseAllSignal}
                expandSignal={expandAllSignal}
                onPatch={(patch) => patchLayer(layer.id, patch)}
                onReplace={(next) => replaceLayer(layer.id, next)}
                onRemove={() => removeLayer(layer.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface LayerCardProps {
  layer: DataLayerSublayer;
  /** Layers with a geometry type: potential parents for a table. */
  spatialLayers: DataLayerSublayer[];
  /** Whether the card starts expanded. Parent picks this so a long
   *  list of layers doesn't blow the page out by default. */
  initialOpen: boolean;
  /** Increment to force-collapse the card from the parent. */
  collapseSignal: number;
  /** Increment to force-expand the card from the parent. */
  expandSignal: number;
  onPatch: (patch: Partial<DataLayerSublayer>) => void;
  onReplace: (next: DataLayerSublayer) => void;
  onRemove: () => void;
}

function LayerCard({
  layer,
  spatialLayers,
  initialOpen,
  collapseSignal,
  expandSignal,
  onPatch,
  onReplace,
  onRemove,
}: LayerCardProps) {
  const [open, setOpen] = useState(initialOpen);
  // Honor global "Collapse all" / "Expand all" commands from the
  // layers list header. Each signal is a numeric counter the parent
  // bumps; we key a one-shot effect off the value change so state
  // resets don't fight the user's manual toggles on subsequent renders.
  useEffect(() => {
    if (collapseSignal > 0) setOpen(false);
  }, [collapseSignal]);
  useEffect(() => {
    if (expandSignal > 0) setOpen(true);
  }, [expandSignal]);
  const geom = GEOMETRY_OPTIONS.find((g) => g.value === layer.geometryType);
  const Icon = geom?.Icon ?? Circle;

  // Signals for pushing collapse commands into FieldRow children
  // without lifting their individual open/closed state up here.
  const [fieldCollapseSignal, setFieldCollapseSignal] = useState(0);
  // Index of the most-recently-added field, for auto-focusing its name
  // input so the user can see: and start typing: the new row
  // immediately rather than hunting for it below expanded settings.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const setField = (index: number, patch: Partial<FeatureField>) => {
    const next = layer.fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onPatch({ fields: next });
  };
  const addField = () => {
    // Collapse existing rows as we append so the new blank row isn't
    // buried under hundreds of pixels of pick-list editor.
    setFieldCollapseSignal((v) => v + 1);
    setFocusIndex(layer.fields.length);
    onPatch({ fields: [...layer.fields, newField()] });
  };
  const removeField = (index: number) =>
    onPatch({ fields: layer.fields.filter((_, i) => i !== index) });

  return (
    <div className="rounded-md border border-border bg-surface-0">
      {/* Header row: icon, label, type-badge, remove, expand chevron.
          Chevron sits on the right edge to match the Schema and
          Version History accordion blocks elsewhere on the detail
          page; #116 was about both inconsistent placement (was on
          the left) and the visual cost of having every layer
          expanded by default on a multi-layer service. The trash
          button stays adjacent to the chevron so destructive +
          structural row controls cluster together. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-accent/10 text-accent">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <input
          type="text"
          value={layer.label}
          onChange={(e) => {
            const nextLabel = e.target.value;
            onPatch({
              label: nextLabel,
              // Keep the slugified name in sync only if the user hasn't
              // manually overridden it (i.e. name matches prior slug).
              name:
                layer.name === slugify(layer.label)
                  ? slugify(nextLabel)
                  : layer.name,
            });
          }}
          placeholder={geom?.label ?? 'Layer'}
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
          {geom?.short ?? 'Layer'}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
          aria-label="Remove layer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {open ? (
        <div className="space-y-4 border-t border-border px-3 py-3">
          {/* Machine name: shown as an advanced-ish detail below the display label. */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs">
            <label
              htmlFor={`${layer.id}-name`}
              className="text-muted"
              title="The name this layer has in the database and in web addresses. Lower case, with underscores instead of spaces."
            >
              Table name
            </label>
            <input
              id={`${layer.id}-name`}
              type="text"
              value={layer.name}
              onChange={(e) => onPatch({ name: slugify(e.target.value) })}
              // An EXAMPLE, not the name of the convention. The
              // placeholder used to read "snake_case", which tells you
              // what shape the answer takes only if you already knew;
              // a tester read it as the literal value he was meant to
              // type. Showing one makes the rule obvious without
              // naming it.
              placeholder="inspection_points"
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>

          <FieldsTable
            fields={layer.fields}
            collapseSignal={fieldCollapseSignal}
            focusIndex={focusIndex}
            onFieldChange={setField}
            onFieldRemove={removeField}
            onFieldAdd={addField}
            onCollapseAll={() => setFieldCollapseSignal((v) => v + 1)}
          />

          <div className="flex flex-wrap items-center gap-4 text-xs text-ink-1">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={layer.editingEnabled}
                onChange={(e) =>
                  onPatch({ editingEnabled: e.target.checked })
                }
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Pencil className="h-3.5 w-3.5 text-muted" />
              Allow editing
            </label>
            <label
              className="inline-flex cursor-pointer items-center gap-1.5"
              title="Attachment storage is a Phase E backend change: the toggle persists so you can opt in now."
            >
              <input
                type="checkbox"
                checked={layer.attachmentsEnabled}
                onChange={(e) =>
                  onPatch({ attachmentsEnabled: e.target.checked })
                }
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Paperclip className="h-3.5 w-3.5 text-muted" />
              Allow attachments
              <span className="text-2xs text-muted">(storage soon)</span>
            </label>
            {/* Layer-level row policy (#41). 'all-rows' (default)
                lets every editor see / edit every row. 'own-rows-only'
                tightens every share so editors only touch features
                they themselves created. Owner / admin always see
                everything. Per-share rowScope='own' can tighten this
                further but never loosen it. */}
            <label
              className="inline-flex cursor-pointer items-center gap-1.5"
              title="Limit editors to the rows they themselves created"
            >
              <span className="text-muted">Editor scope</span>
              <select
                value={layer.editingPolicy ?? 'all-rows'}
                onChange={(e) =>
                  onPatch({
                    editingPolicy: e.target.value as
                      | 'all-rows'
                      | 'own-rows-only',
                  })
                }
                className="h-7 rounded-md border border-border bg-surface-1 px-2 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="all-rows">All features</option>
                <option value="own-rows-only">Only their own</option>
              </select>
            </label>
          </div>

          {layer.geometryType === null ? (
            <ParentLinkRow
              layer={layer}
              spatialLayers={spatialLayers}
              onPatch={onPatch}
              onReplace={onReplace}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FieldsTableProps {
  fields: FeatureField[];
  /** Bumped by the parent to force-collapse every row's settings
   *  pane. Mirrors the layer-level collapse signal. */
  collapseSignal: number;
  /** When set, the FieldRow at this index auto-focuses its name
   *  input after mount. Used to draw the eye to a freshly-added row. */
  focusIndex: number | null;
  onFieldChange: (index: number, patch: Partial<FeatureField>) => void;
  onFieldRemove: (index: number) => void;
  onFieldAdd: () => void;
  onCollapseAll: () => void;
}

function FieldsTable({
  fields,
  collapseSignal,
  focusIndex,
  onFieldChange,
  onFieldRemove,
  onFieldAdd,
  onCollapseAll,
}: FieldsTableProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">
          Fields {fields.length > 0 ? <span className="text-muted">({fields.length})</span> : null}
        </p>
        <div className="flex items-center gap-1">
          {fields.length > 1 ? (
            <button
              type="button"
              onClick={onCollapseAll}
              className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-2xs text-muted hover:bg-surface-2 hover:text-ink-1"
              title="Collapse every field's settings panel"
            >
              <ChevronUp className="h-3 w-3" />
              Collapse all
            </button>
          ) : null}
          <button
            type="button"
            onClick={onFieldAdd}
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-2xs text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            Add field
          </button>
        </div>
      </div>
      {fields.length === 0 ? (
        <p className="rounded border border-dashed border-border bg-surface-1 px-2 py-3 text-center text-2xs text-muted">
          No fields yet. Every feature will have a stable id; add fields
          above to store additional attributes.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">
                  <GripVertical className="inline h-3 w-3" />
                </th>
                <th className="px-2 py-1.5 text-left font-medium">Name</th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-left font-medium">Label</th>
                <th className="px-2 py-1.5 text-center font-medium">Required</th>
                <th className="px-2 py-1.5 text-center font-medium">
                  <span title="Pick list / coded values">Values</span>
                </th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  collapseSignal={collapseSignal}
                  autoFocus={focusIndex === i}
                  onChange={(patch) => onFieldChange(i, patch)}
                  onRemove={() => onFieldRemove(i)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Second "Add field" trigger lives below the table so it's
          always visible even when several rows have their settings
          panel expanded: the top button can end up scrolled off
          with a dense layer. */}
      {fields.length > 0 ? (
        <button
          type="button"
          onClick={onFieldAdd}
          className="mt-2 inline-flex h-7 w-full items-center justify-center gap-1 rounded border border-dashed border-border bg-surface-1 px-2 text-2xs font-medium text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-ink-1"
        >
          <Plus className="h-3 w-3" />
          Add another field
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: FeatureField;
  /** Parent-driven collapse counter: bumps force-close the settings
   *  pane. Auto-bumped when a new field is added so the page doesn't
   *  lengthen indefinitely, and manually bumped by "Collapse all". */
  collapseSignal: number;
  /** When true, auto-focus the name input once after mount. */
  autoFocus: boolean;
  onChange: (patch: Partial<FeatureField>) => void;
  onRemove: () => void;
}

/**
 * Single field row. Renders the header inputs (name/type/label/required)
 * and a collapsible pick-list editor below. A field-level "domain" is
 * Esri-terminology for a coded-value constraint; we keep the same model
 * so imports from ArcGIS-land carry over cleanly.
 *
 * Boolean and date fields don't get a pick list (booleans are already
 * binary; dates rarely benefit from a fixed list). The toggle button
 * is disabled in those cases.
 */
function FieldRow({
  field,
  collapseSignal,
  autoFocus,
  onChange,
  onRemove,
}: FieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Collapse on parent signal. First render (signal === 0) is a no-op
  // so existing rows don't flicker closed on mount.
  useEffect(() => {
    if (collapseSignal > 0) setExpanded(false);
  }, [collapseSignal]);

  // One-shot auto-focus for freshly-added rows so the user's eye
  // lands on the new field and their next keystroke starts typing
  // the name.
  useEffect(() => {
    if (autoFocus && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    // Only react to autoFocus going true once on mount / add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hasDomain =
    field.domain !== undefined &&
    (field.domain.type === 'coded-value' ||
      field.domain.type === 'coded-value-ref');
  const isRefDomain =
    field.domain !== undefined && field.domain.type === 'coded-value-ref';
  // multi_select REQUIRES a domain (the array's codes have to come from
  // somewhere). string and number can optionally carry one; boolean and
  // date never do. The wizard's type-switch handler seeds a blank
  // coded-value list when the user picks multi_select so the domain
  // editor shows immediately.
  const canHaveDomain =
    field.type === 'string' ||
    field.type === 'number' ||
    field.type === 'multi_select';
  // "Advanced" constraints apply to strings (maxLength) and numbers
  // (integer/decimal + precision/scale). Boolean, date, and
  // multi_select get nothing to configure at the storage level.
  const canHaveConstraints = field.type === 'string' || field.type === 'number';
  const hasConstraints = field.storage !== undefined && (
    field.storage.maxLength !== undefined ||
    field.storage.numberKind !== undefined ||
    field.storage.precision !== undefined ||
    field.storage.scale !== undefined
  );
  const anySettings = canHaveDomain || canHaveConstraints;

  function enableDomain() {
    // Seed with a single blank row so the user has something to type into.
    const seed: FieldDomain = {
      type: 'coded-value',
      values: [{ code: field.type === 'number' ? 0 : '', label: '' }],
    };
    onChange({ domain: seed });
    setExpanded(true);
  }

  function disableDomain() {
    // exactOptionalPropertyTypes: drop the key entirely rather than set undefined.
    const { domain: _d, ...rest } = field;
    void _d;
    onChange(rest as Partial<FeatureField>);
    setExpanded(false);
  }

  return (
    <>
      <tr className="border-t border-border">
        <td className="px-2 py-1 text-muted">
          <GripVertical className="h-3 w-3" />
        </td>
        <td className="px-1 py-1">
          <input
            ref={nameInputRef}
            type="text"
            value={field.name}
            onChange={(e) => onChange({ name: slugify(e.target.value) })}
            placeholder="field_name"
            className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </td>
        <td className="px-1 py-1">
          <select
            value={field.type}
            onChange={(e) => {
              const nextType = e.target.value as FeatureFieldType;
              // Switching to a type that can't hold a domain drops it
              // rather than leaving stale coded values behind.
              if (
                (nextType === 'boolean' || nextType === 'date') &&
                field.domain
              ) {
                const { domain: _d, ...rest } = field;
                void _d;
                onChange({ ...(rest as Partial<FeatureField>), type: nextType });
                return;
              }
              // Switching TO multi_select with no existing domain seeds a
              // blank coded-value list so the user immediately sees the
              // domain editor and is nudged to pick a pick list. Without
              // this they'd land on a multi_select with no codes, which
              // is a useless field.
              if (nextType === 'multi_select' && !field.domain) {
                onChange({
                  type: nextType,
                  domain: {
                    type: 'coded-value',
                    values: [{ code: '', label: '' }],
                  },
                });
                return;
              }
              onChange({ type: nextType });
            }}
            className="h-7 w-full rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {FIELD_TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </td>
        <td className="px-1 py-1">
          <input
            type="text"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder={field.name || 'Display label'}
            className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </td>
        <td className="px-2 py-1 text-center">
          <input
            type="checkbox"
            checked={!field.nullable}
            onChange={(e) => onChange({ nullable: !e.target.checked })}
            className="h-3.5 w-3.5 rounded border-border"
            aria-label="Required"
          />
        </td>
        <td className="px-1 py-1 text-center">
          {/* Generic settings expander: holds the pick-list editor AND
              advanced constraints (maxLength, number kind, precision).
              Active state is shown when the field has either a domain
              or any non-default storage hint so authors can tell at a
              glance which rows carry extra configuration. */}
          {anySettings ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-2xs font-medium ${
                hasDomain || hasConstraints
                  ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1'
              }`}
              title={
                hasDomain || hasConstraints
                  ? 'Edit field settings (pick list, constraints)'
                  : 'Add pick list or constraints'
              }
              aria-expanded={expanded}
            >
              {hasDomain ? (
                <>
                  <List className="h-3 w-3" />
                  {isRefDomain
                    ? 'ref'
                    : (field.domain as { values: unknown[] }).values.length}
                </>
              ) : hasConstraints ? (
                <>
                  <List className="h-3 w-3" />
                  set
                </>
              ) : (
                <>
                  <Plus className="h-3 w-3" />
                  settings
                </>
              )}
            </button>
          ) : (
            <span
              className="text-2xs text-muted"
              title="Settings apply to text or number fields"
            >
             
            </span>
          )}
        </td>
        <td className="px-1 py-1">
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
            aria-label="Remove field"
          >
            <Minus className="h-3 w-3" />
          </button>
        </td>
      </tr>
      {expanded && anySettings ? (
        <tr className="border-t border-border bg-surface-1">
          <td colSpan={7} className="space-y-4 px-3 py-3">
            {canHaveDomain ? (
              hasDomain ? (
                <DomainEditor
                  field={field}
                  onChange={onChange}
                  onDisable={disableDomain}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-border bg-surface-0 px-3 py-2">
                  <div>
                    <p className="text-2xs font-medium uppercase tracking-wide text-muted">
                      Pick list
                    </p>
                    <p className="text-2xs text-muted">
                      Restrict this field to a short, authoritative list
                      of allowed values. Type them inline or point at a
                      shared pick-list item.
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={enableDomain}
                      className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
                    >
                      <Plus className="h-3 w-3" />
                      Add inline
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          domain: { type: 'coded-value-ref', pickListItemId: '' },
                        })
                      }
                      className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
                    >
                      <List className="h-3 w-3" />
                      Use shared list
                    </button>
                  </div>
                </div>
              )
            ) : null}

            {canHaveConstraints ? (
              <ConstraintsEditor field={field} onChange={onChange} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

interface ConstraintsEditorProps {
  field: FeatureField;
  onChange: (patch: Partial<FeatureField>) => void;
}

/**
 * Advanced storage hints for a field. Optional: authors who don't
 * care can ignore them and PostgreSQL's defaults (TEXT, NUMERIC) will
 * carry everything. Shown only for string and number fields since
 * boolean and date have nothing to configure.
 *
 * Under the hood this writes to `field.storage`. When every knob is
 * cleared we remove the whole `storage` object so the saved blob
 * stays tidy.
 */
function ConstraintsEditor({ field, onChange }: ConstraintsEditorProps) {
  const storage = field.storage ?? {};

  // Accept undefined values here explicitly: callers pass `undefined`
  // to mean "clear this key", and exactOptionalPropertyTypes would
  // otherwise reject that on the stricter FeatureFieldStorage shape.
  function patchStorage(
    patch: Partial<Record<keyof FeatureFieldStorage, unknown>>,
  ) {
    const merged: FeatureFieldStorage = { ...storage };
    for (const [k, v] of Object.entries(patch) as Array<
      [keyof FeatureFieldStorage, unknown]
    >) {
      if (
        v === undefined ||
        v === '' ||
        (typeof v === 'number' && Number.isNaN(v))
      ) {
        delete (merged as Record<string, unknown>)[k];
      } else {
        (merged as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(merged).length === 0) {
      const { storage: _s, ...rest } = field;
      void _s;
      onChange(rest as Partial<FeatureField>);
    } else {
      onChange({ storage: merged });
    }
  }

  return (
    <div className="rounded border border-border bg-surface-0 p-3">
      <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">
        Constraints
      </p>

      {field.type === 'string' ? (
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs">
          <label
            htmlFor={`${field.name || 'fld'}-maxlen`}
            className="text-ink-1"
          >
            Max length
            <span className="ml-1 text-2xs text-muted">
              characters: leave blank for unlimited
            </span>
          </label>
          <input
            id={`${field.name || 'fld'}-maxlen`}
            type="number"
            min={1}
            max={10_000}
            value={storage.maxLength ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              const n = raw === '' ? undefined : Number(raw);
              patchStorage({ maxLength: n });
            }}
            placeholder="none"
            className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </div>
      ) : null}

      {field.type === 'number' ? (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            <label className="text-ink-1">
              Number kind
              <span className="ml-1 text-2xs text-muted">
                integer = whole numbers only; decimal keeps fractional precision
              </span>
            </label>
            <select
              value={storage.numberKind ?? 'decimal'}
              onChange={(e) =>
                patchStorage({
                  numberKind: e.target.value as 'integer' | 'decimal',
                })
              }
              className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="decimal">Decimal</option>
              <option value="integer">Integer</option>
            </select>
          </div>
          {(storage.numberKind ?? 'decimal') === 'decimal' ? (
            <>
              <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                <label
                  htmlFor={`${field.name || 'fld'}-prec`}
                  className="text-ink-1"
                >
                  Total digits (precision)
                  <span className="ml-1 text-2xs text-muted">
                    e.g. 10 for 12345.6789
                  </span>
                </label>
                <input
                  id={`${field.name || 'fld'}-prec`}
                  type="number"
                  min={1}
                  max={38}
                  value={storage.precision ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    patchStorage({
                      precision: raw === '' ? undefined : Number(raw),
                    });
                  }}
                  placeholder="auto"
                  className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                <label
                  htmlFor={`${field.name || 'fld'}-scale`}
                  className="text-ink-1"
                >
                  Digits after decimal (scale)
                  <span className="ml-1 text-2xs text-muted">
                    e.g. 4 for …6789
                  </span>
                </label>
                <input
                  id={`${field.name || 'fld'}-scale`}
                  type="number"
                  min={0}
                  max={38}
                  value={storage.scale ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    patchStorage({
                      scale: raw === '' ? undefined : Number(raw),
                    });
                  }}
                  placeholder="auto"
                  className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-2xs text-muted">
        These are optional. PostgreSQL stores text as unlimited TEXT and
        numbers as arbitrary-precision NUMERIC by default: set these only
        when you need Esri/shapefile export compatibility or strict input
        validation.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface DomainEditorProps {
  field: FeatureField;
  onChange: (patch: Partial<FeatureField>) => void;
  onDisable: () => void;
}

/**
 * Dispatches to either the inline coded-value editor or the shared
 * pick-list picker based on the current domain variant. Offers a
 * toggle so authors can switch between the two without losing state
 * that doesn't overlap: switching from inline → shared just drops
 * the inline values; switching the other way leaves the user with an
 * empty inline list to populate.
 */
function DomainEditor({ field, onChange, onDisable }: DomainEditorProps) {
  const domain = field.domain;
  if (!domain) return null;

  function setValues(next: Array<{ code: string | number; label: string }>) {
    onChange({ domain: { type: 'coded-value', values: next } });
  }

  function switchToRef() {
    onChange({ domain: { type: 'coded-value-ref', pickListItemId: '' } });
  }
  function switchToInline() {
    onChange({
      domain: {
        type: 'coded-value',
        values: [{ code: field.type === 'number' ? 0 : '', label: '' }],
      },
    });
  }

  // Both sub-editors call this to swap the field over to a freshly-
  // created shared pick list without a round-trip through the detail
  // page. The "use this field's label as the default title" hint is
  // why we thread `field` through the DomainEditor.
  function usePickListItemId(id: string) {
    onChange({ domain: { type: 'coded-value-ref', pickListItemId: id } });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">
          Pick list source
        </p>
        <div className="inline-flex rounded border border-border bg-surface-1 p-0.5 text-2xs">
          <button
            type="button"
            onClick={switchToInline}
            className={`px-2 py-0.5 rounded ${
              domain.type === 'coded-value'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            Inline
          </button>
          <button
            type="button"
            onClick={switchToRef}
            className={`px-2 py-0.5 rounded ${
              domain.type === 'coded-value-ref'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            Shared list
          </button>
        </div>
      </div>

      {domain.type === 'coded-value' ? (
        <CodedValueEditor
          fieldType={field.type}
          values={domain.values}
          fieldLabel={field.label || field.name}
          onChange={setValues}
          onDisable={onDisable}
          onPromoteToShared={usePickListItemId}
        />
      ) : domain.type === 'coded-value-ref' ? (
        <SharedPickListRefEditor
          pickListItemId={domain.pickListItemId}
          fieldLabel={field.label || field.name}
          onChange={usePickListItemId}
          onDisable={onDisable}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SharedPickListRefEditorProps {
  pickListItemId: string;
  fieldLabel: string;
  onChange: (id: string) => void;
  onDisable: () => void;
}

/**
 * Picker + preview for a coded-value-ref domain. Fetches the caller's
 * visible pick_list items from /api/portal/items?type=pick_list and
 * lets them pick one. Also shows a lightweight preview of the selected
 * list's first few entries so authors can sanity-check the choice.
 *
 * Includes an in-context "Create new" button that opens a modal to
 * stand up a brand-new shared pick list without leaving the builder.
 * The new list is auto-selected so the user's flow continues without
 * a detour to /items.
 */
function SharedPickListRefEditor({
  pickListItemId,
  fieldLabel,
  onChange,
  onDisable,
}: SharedPickListRefEditorProps) {
  const [lists, setLists] = useState<
    Array<{ id: string; title: string; description?: string | null }>
  >([]);
  const [preview, setPreview] = useState<
    Array<{ code: string; label: string }> | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Load the visible pick_list items once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/portal/items?type=pick_list')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; title: string; description?: string }>) => {
        if (!cancelled) setLists(rows);
      })
      .catch(() => {
        /* leave list empty: user can still type an ID */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull the selected pick list's entries for preview.
  useEffect(() => {
    if (!pickListItemId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    fetch(`/api/portal/items/${pickListItemId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (item: null | {
          data?: { entries?: Array<{ code: string; label: string }> };
        }) => {
          if (cancelled) return;
          const entries = item?.data?.entries ?? [];
          setPreview(entries.slice(0, 6));
        },
      )
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickListItemId]);

  return (
    <div className="rounded border border-border bg-surface-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">
          Shared pick list
        </p>
        <button
          type="button"
          onClick={onDisable}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted hover:bg-surface-2 hover:text-ink-1"
          title="Remove the pick list: any value becomes allowed again"
        >
          <X className="h-3 w-3" />
          Disable
        </button>
      </div>

      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-muted">
          Reference
        </span>
        <div className="flex items-center gap-1.5">
          <select
            value={pickListItemId}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 flex-1 rounded border border-border bg-surface-1 px-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            disabled={loading}
          >
            <option value="">
              {loading
                ? 'Loading…'
                : lists.length === 0
                  ? 'No shared pick lists yet: create one below'
                  : 'Select a pick list…'}
            </option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-8 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
            title="Create a new shared pick list without leaving the builder"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
      </label>

      {createOpen ? (
        <CreateSharedPickListDialog
          defaultTitle={suggestedPickListTitle(fieldLabel)}
          onClose={() => setCreateOpen(false)}
          onCreated={(newId, newTitle) => {
            // Add to the local cache so the select shows it without a
            // full refetch, and auto-select it.
            setLists((prev) => [{ id: newId, title: newTitle }, ...prev]);
            onChange(newId);
            setCreateOpen(false);
          }}
        />
      ) : null}

      {pickListItemId ? (
        <div className="mt-2 rounded border border-border bg-surface-1 p-2 text-2xs">
          <p className="mb-1 uppercase tracking-wide text-muted">Preview</p>
          {previewLoading ? (
            <p className="text-muted">Loading entries…</p>
          ) : preview && preview.length > 0 ? (
            <ul className="space-y-0.5">
              {preview.map((e) => (
                <li key={e.code} className="flex items-center gap-2">
                  <code className="rounded bg-surface-2 px-1 font-mono">
                    {e.code}
                  </code>
                  <span className="text-ink-1">{e.label}</span>
                </li>
              ))}
              <li className="pt-1 text-muted">
                Showing first {preview.length}. Edits to the source list
                flow through automatically.
              </li>
            </ul>
          ) : (
            <p className="text-muted">
              The list has no entries yet. Open it to add some.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CodedValueEditorProps {
  fieldType: FeatureFieldType;
  values: Array<{ code: string | number; label: string }>;
  fieldLabel: string;
  onChange: (values: Array<{ code: string | number; label: string }>) => void;
  onDisable: () => void;
  /**
   * Fires after the user promotes the current inline values into a new
   * shared pick list: hands the new pick_list item id back so the
   * field can switch its domain over to `coded-value-ref`.
   */
  onPromoteToShared: (newItemId: string) => void;
}

/**
 * Inline editor for a coded-value domain. Two columns per row (code +
 * label) with an add / delete affordance per row and a "turn off" link
 * that removes the domain from the field entirely.
 */
function CodedValueEditor({
  fieldType,
  values,
  fieldLabel,
  onChange,
  onDisable,
  onPromoteToShared,
}: CodedValueEditorProps) {
  const [promoteOpen, setPromoteOpen] = useState(false);
  function patch(index: number, patchObj: Partial<{ code: string | number; label: string }>) {
    const next = values.map((v, i) => (i === index ? { ...v, ...patchObj } : v));
    onChange(next);
  }
  function add() {
    onChange([...values, { code: fieldType === 'number' ? 0 : '', label: '' }]);
  }
  function removeAt(index: number) {
    const next = values.filter((_, i) => i !== index);
    // If the last row was deleted, keep one empty row so the UI stays
    // usable rather than collapsing to a "no values" state that the
    // user then has to re-enable.
    onChange(
      next.length === 0
        ? [{ code: fieldType === 'number' ? 0 : '', label: '' }]
        : next,
    );
  }

  // "Promotable" means: the user has at least one complete entry
  // we can copy into a new shared list. Empty or partial rows are
  // filtered out so the new list starts clean.
  const promotable = values.filter(
    (v) =>
      String(v.code ?? '').trim().length > 0 &&
      String(v.label ?? '').trim().length > 0,
  );

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">
          Allowed values
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPromoteOpen(true)}
            disabled={promotable.length === 0}
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            title={
              promotable.length === 0
                ? 'Add at least one complete code + label row first'
                : 'Promote these values into a reusable shared pick list'
            }
          >
            <ListChecks className="h-3 w-3" />
            Save as shared list
          </button>
          <button
            type="button"
            onClick={onDisable}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted hover:bg-surface-2 hover:text-ink-1"
            title="Remove the pick list: any value becomes allowed again"
          >
            <X className="h-3 w-3" />
            Disable pick list
          </button>
        </div>
      </div>

      {promoteOpen ? (
        <CreateSharedPickListDialog
          defaultTitle={suggestedPickListTitle(fieldLabel)}
          seedEntries={promotable.map((v) => ({
            code: String(v.code),
            label: v.label,
          }))}
          onClose={() => setPromoteOpen(false)}
          onCreated={(newId) => {
            setPromoteOpen(false);
            onPromoteToShared(newId);
          }}
        />
      ) : null}
      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-muted">
            <tr>
              <th className="w-[40%] px-2 py-1 text-left font-medium">
                Code
                <span
                  className="ml-1 text-2xs uppercase text-muted"
                  title="The stored value"
                >
                  stored
                </span>
              </th>
              <th className="w-[55%] px-2 py-1 text-left font-medium">
                Label
                <span
                  className="ml-1 text-2xs uppercase text-muted"
                  title="What the user sees"
                >
                  shown
                </span>
              </th>
              <th className="px-1 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {values.map((v, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-1 py-1">
                  <input
                    type={fieldType === 'number' ? 'number' : 'text'}
                    value={String(v.code)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const code =
                        fieldType === 'number'
                          ? raw === ''
                            ? 0
                            : Number(raw)
                          : raw;
                      patch(i, { code });
                    }}
                    placeholder={fieldType === 'number' ? '0' : 'code'}
                    className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={v.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder="Display label"
                    className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
                    aria-label="Remove value"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Plus className="h-3 w-3" />
        Add value
      </button>
      <p className="mt-1 text-2xs text-muted">
        The code is what&apos;s stored in the database; the label is what
        editors see in the picker.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ParentLinkProps {
  layer: DataLayerSublayer;
  spatialLayers: DataLayerSublayer[];
  onPatch: (patch: Partial<DataLayerSublayer>) => void;
  onReplace: (next: DataLayerSublayer) => void;
}

/**
 * Row inside a table-type layer card that lets the user declare this
 * table as a child of one of the spatial layers in the same item. The
 * FK column gets a sensible default based on the parent's slug.
 */
function ParentLinkRow({
  layer,
  spatialLayers,
  onPatch,
  onReplace,
}: ParentLinkProps) {
  const parentOptions = spatialLayers;
  const defaultFkForParent = (parentId: string): string => {
    const p = parentOptions.find((l) => l.id === parentId);
    return p ? `${p.name}_global_id` : 'parent_global_id';
  };

  return (
    <div className="rounded border border-border bg-surface-1 p-2">
      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted">
        Related to
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs">
        <label htmlFor={`${layer.id}-parent`} className="text-muted">
          Parent layer
        </label>
        <select
          id={`${layer.id}-parent`}
          value={layer.parentLayerId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              // Clearing the parent: rebuild the layer without the
              // optional parent/fk props so exactOptionalPropertyTypes
              // stays happy. onReplace (not onPatch) is required here
              // so the omitted keys actually disappear instead of
              // merging back in from the previous layer.
              const {
                parentLayerId: _p,
                parentFkColumn: _fk,
                ...rest
              } = layer;
              void _p;
              void _fk;
              onReplace(rest);
              return;
            }
            // Auto-fill the FK column with a sensible default when the
            // user picks a parent for the first time. If they already
            // edited the column name, respect their value.
            onPatch({
              parentLayerId: v,
              parentFkColumn: layer.parentFkColumn || defaultFkForParent(v),
            });
          }}
          className="h-7 w-full rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        >
          <option value="">- None (standalone table) -</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {layer.parentLayerId ? (
          <>
            <label htmlFor={`${layer.id}-fk`} className="text-muted">
              FK column
            </label>
            <input
              id={`${layer.id}-fk`}
              type="text"
              value={layer.parentFkColumn ?? ''}
              onChange={(e) =>
                onPatch({ parentFkColumn: slugify(e.target.value) })
              }
              placeholder="parent_global_id"
              className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </>
        ) : null}
      </div>
      {parentOptions.length === 0 ? (
        <p className="mt-1 text-2xs text-muted">
          Add a spatial layer above first to link this table to.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Pending feature import surfaced to the parent wizard so it can fan
 * out per-layer ingest from a single staged file after Create item.
 * One entry per uploaded file (maybe several per wizard session if
 * the user imports more than one source); each entry lists the
 * layer ids that came from it plus the GDAL source-layer name we
 * need to pass at ingest time.
 */
export interface PendingFileImport {
  stagingId: string;
  fileName: string;
  layers: Array<{ layerId: string; sourceLayerName: string }>;
}

interface ImportPanelProps {
  onClose: () => void;
  onImport: (
    layers: DataLayerSublayer[],
    pending?: PendingFileImport,
  ) => void;
}

/**
 * Import panel: multi-format.
 *
 * GeoJSON / JSON is still parsed client-side (fast, no server round-
 * trip). Everything else (KML, KMZ, shapefile zip, File GDB zip) is
 * POSTed to /api/ingest/probe, which uses GDAL on the server to list
 * layers + fields. Authors can then pick which of those layers to add
 * as builder layers. Feature data itself is loaded later via
 * /items/:id/layers/:layerId/import after the item is created: this
 * panel only seeds the schema.
 */

interface ProbedLayer {
  name: string;
  geometryType: 'point' | 'line' | 'polygon' | null;
  fields: Array<{ name: string; type: FeatureFieldType }>;
  featureCount: number;
}

function ImportPanel({ onClose, onImport }: ImportPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<UploadBusy | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Swallow drops that land anywhere else on the page while this
  // panel is open.
  //
  // The browser's default action for a dropped file is to navigate to
  // it, which throws away a half-filled wizard: title, description,
  // tags, visibility, every layer defined so far. A near miss on the
  // drop zone is the most likely way to trigger it, and it is the
  // moment the user has the most to lose. Nothing here handles the
  // file, it just declines to leave the page.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);
  // Live XHR ref so the user can cancel a long upload mid-flight. The
  // ref is also how the abort path knows whether anything is actually
  // in flight (handles double-clicks on Cancel gracefully).
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  function cancelUpload() {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setBusy(null);
    setError(null);
  }

  async function handleFile(file: File) {
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    // GeoJSON stays client-side: it's small and parses quickly.
    if (ext === 'geojson' || ext === 'json') {
      setBusy({
        phase: 'parsing',
        fileName: file.name,
        fileSize: file.size,
        bytesUploaded: 0,
      });
      try {
        const text = await file.text();
        const fc = JSON.parse(text);
        if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
          setError('File is not a valid GeoJSON FeatureCollection.');
          return;
        }
        const first = fc.features.find(
          (f: { geometry?: { type?: string } | null }) => f.geometry,
        );
        const geomKind = first?.geometry?.type?.toLowerCase() ?? '';
        const geometryType: LayerGeometryType = geomKind.includes('point')
          ? 'point'
          : geomKind.includes('line')
            ? 'line'
            : geomKind.includes('polygon')
              ? 'polygon'
              : 'point';
        const fields = deriveFieldsFromFeatures(fc.features, 500);
        const layer = newLayer(geometryType);
        layer.label = file.name.replace(/\.(geojson|json)$/i, '');
        layer.name = slugify(layer.label);
        layer.fields = fields;
        layer.featureCount = fc.features.length;
        onImport([layer]);
      } catch (err) {
        setError((err as Error).message || 'Failed to parse file.');
      } finally {
        setBusy(null);
      }
      return;
    }

    // KML / KMZ / shapefile zip / GDB / GeoPackage / anything
    // OGR-readable: send to /ingest/stage. The server parks the file
    // under /tmp/gg-staging/<id>/ and returns a stagingId plus the
    // schema preview. After Create item the wizard fans out per-layer
    // ingest using ?stagingId=... so a 503 MB GDB only travels the
    // wire once. Stagings expire after an hour; if the user idles
    // longer the per-layer ingest fails and they re-upload.
    //
    // We use XMLHttpRequest instead of fetch() because fetch has no
    // upload-progress hook. For a 200 MB+ shapefile zip the user would
    // otherwise stare at a tiny "Uploading..." string for a minute
    // and assume the dialog was hung. XHR's upload.onprogress lets
    // us paint a real bar from 0 to 100, then flip the label to
    // "Reading on the server..." once the upload finishes and the
    // GDAL probe runs.
    try {
      const out = await uploadWithProgress<{
        stagingId: string;
        driver: string;
        layers: ProbedLayer[];
      }>(
        '/api/portal/ingest/stage',
        file,
        (e) => {
          setBusy((prev) =>
            prev
              ? {
                  ...prev,
                  phase: e.phase,
                  bytesUploaded: e.bytesUploaded,
                }
              : {
                  phase: e.phase,
                  fileName: file.name,
                  fileSize: file.size,
                  bytesUploaded: e.bytesUploaded,
                },
          );
        },
        xhrRef,
      );
      xhrRef.current = null;
      // Auto-attach every detected layer instead of dropping the user
      // into a "pick which layers" picker. The picker was confusing
      // ("I clicked Import, why do I have another button to click?")
      // and almost everyone wanted everything in the file anyway. If
      // a user genuinely wants to drop a layer they can remove it
      // from the wizard list below before clicking Create item. Same
      // behaviour the single-layer branch has always had, extended to
      // multi-layer files.
      addProbedLayers(file.name, out.layers, undefined, out.stagingId);
    } catch (err) {
      // Cancellations come through here too; don't show "Probe failed"
      // in that case since the user explicitly aborted.
      if ((err as Error).name === 'AbortError') {
        // No-op; cancelUpload already cleared state.
      } else {
        setError((err as Error).message || 'Probe failed.');
      }
    } finally {
      setBusy(null);
      xhrRef.current = null;
    }
  }

  function addProbedLayers(
    fileName: string,
    layers: ProbedLayer[],
    pickName?: string,
    stagingId?: string,
  ) {
    const toAdd = pickName
      ? layers.filter((l) => l.name === pickName)
      : layers;
    // Build layers in tandem with their layerId<->sourceLayerName
    // mapping so the wizard can later fan out per-layer ingest from
    // the staging without losing track of which layer came from
    // which source name (matters for multi-layer GDBs where the
    // sourceLayer query parameter is required).
    const built: DataLayerSublayer[] = [];
    const pendingLayers: Array<{
      layerId: string;
      sourceLayerName: string;
    }> = [];
    for (const pl of toAdd) {
      const label = pl.name || fileName;
      const layer = newLayer(pl.geometryType);
      layer.label = label;
      layer.name = slugify(label);
      layer.fields = pl.fields.map((f) => ({
        name: f.name,
        type: f.type,
        label: f.name,
        nullable: true,
      }));
      layer.featureCount = pl.featureCount;
      built.push(layer);
      if (stagingId) {
        pendingLayers.push({ layerId: layer.id, sourceLayerName: pl.name });
      }
    }
    if (stagingId && pendingLayers.length > 0) {
      onImport(built, { stagingId, fileName, layers: pendingLayers });
    } else {
      onImport(built);
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-0">Import from file</p>
        <button
          type="button"
          onClick={onClose}
          className="text-2xs text-muted hover:text-ink-1"
        >
          Close
        </button>
      </div>

      {busy ? (
        <UploadProgressPanel busy={busy} onCancel={cancelUpload} />
      ) : (
        <>
          {/* A real drop target. The copy here promised one for a long
              time while no onDrop handler existed anywhere in the
              component, and a native file input does not receive drops
              through its label, so dropping a file made the browser
              navigate to it and the half-filled wizard was gone. */}
          <label
            htmlFor="fs-builder-import"
            onDragOver={(e) => {
              // Both preventDefault calls are load bearing. Without
              // one on dragover the drop event never fires at all.
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              // Fires when crossing onto a child too, so only clear
              // when the pointer has actually left the zone.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded border border-dashed px-3 py-4 text-xs transition-colors ${
              dragOver
                ? 'border-accent bg-accent/10 text-ink-1'
                : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
            }`}
          >
            <Upload className="h-4 w-4" />
            <span>
              {dragOver ? 'Drop to import.' : 'Drop a file here, or click to pick one.'}
            </span>
            {/* Lead with what most people actually have. The list
                below used to open with format names, and a tester who
                had a spreadsheet did not recognise that "CSV / TSV
                with latitude and longitude columns" described it, so
                he skipped the feature. The full list still follows,
                because the people who do know their format need to
                see it supported. */}
            <span className="text-2xs">
              A spreadsheet saved as CSV, with a latitude and a
              longitude column, is the usual one.
            </span>
            <span className="text-2xs opacity-80">
              Also: TSV · GeoJSON · GeoParquet (.parquet) · KML / KMZ
              (Google Earth) · GeoPackage (.gpkg, vector tables only) ·
              Shapefile (.zip) · File Geodatabase (.gdb.zip)
            </span>
            <input
              id="fs-builder-import"
              type="file"
              accept=".csv,.tsv,.txt,.geojson,.json,.parquet,.geoparquet,.kml,.kmz,.gpkg,.zip,.gdb"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </label>
          {/*
            Hint about the two-step nature of multi-layer import. The
            wizard auto-attaches every layer it detects in the file
            (point/line/polygon and any related tables); the schema
            lands but the rows do not. After Create item, each layer
            shows its own Import features button on the detail page
            for the actual feature load. A future change will fold
            that into Create item itself (#98).
          */}
          <p className="mt-2 text-2xs text-muted">
            All layers in the file will attach automatically. Schema lands
            on Create item; load feature rows per layer afterwards from
            the detail page.
          </p>
        </>
      )}

      {error ? (
        <p className="mt-2 text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Mirror of the deriveFields helper used by the single-layer editor.
 * Kept local so the wizard doesn't need to reach into the [id] route
 * folder (which, as we learned the hard way, confuses webpack).
 */
function deriveFieldsFromFeatures(
  features: Array<{ properties?: Record<string, unknown> | null }>,
  sampleSize: number,
): FeatureField[] {
  const seen = new Map<string, FeatureFieldType>();
  const limit = Math.min(features.length, sampleSize);
  for (let i = 0; i < limit; i++) {
    const props = features[i]?.properties;
    if (!props) continue;
    for (const [k, v] of Object.entries(props)) {
      if (seen.has(k)) continue;
      seen.set(k, inferType(v));
    }
  }
  return Array.from(seen.entries()).map(([name, type]) => ({
    name,
    type,
    label: humanize(name),
    nullable: true,
  }));
}

function inferType(v: unknown): FeatureFieldType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') {
    // Cheap ISO date sniff.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
    return 'string';
  }
  return 'string';
}

function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Default title seed for the "create shared pick list" dialog. Falls
 * back to a generic "Pick list" if the field doesn't have a usable
 * label yet. Keeps the wording neutral so the user naturally edits it
 * before saving rather than inheriting "Priority options" forever.
 */
function suggestedPickListTitle(fieldLabel: string): string {
  const trimmed = (fieldLabel ?? '').trim();
  if (!trimmed) return 'Pick list';
  return `${trimmed} options`;
}
