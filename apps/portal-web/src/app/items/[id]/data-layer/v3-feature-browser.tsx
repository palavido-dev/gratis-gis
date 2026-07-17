// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  exportFeatures,
  exportLayerGeoParquet,
  type ClientExportFormat,
} from '@/lib/layer-export';
import { exportBundle } from '@/lib/bundle-export';
import { toast } from '@/lib/toast';
import type {
  FeatureRecord,
  DataLayerSublayer,
  FeatureField,
} from '@gratis-gis/shared-types';
import { V3FeatureAttachments } from './v3-feature-attachments';
import { useConfirm } from '@/components/dialog-provider';

/**
 * Inline feature browser + editor for a single v3 layer.
 *
 * Reads from /items/:id/layers/:layerId/features, renders a compact
 * table of all fields (plus a stable `fid` column), and offers per-row
 * edit / delete via the controller's PATCH / DELETE endpoints. New
 * rows are appended via POST with an empty geometry: the layer's
 * geometry gets filled in later via the map editor, or left null for
 * attribute-only related tables.
 *
 * Design notes:
 *  - Editing is property-only for v1. Geometry editing stays in the
 *    map editor where there's a real map canvas to click on.
 *  - We load the whole feature list on open: same assumption v2's
 *    geojson endpoint made. If layers get large (>10k rows) we'll
 *    paginate here; for now "load all" keeps the code simple and
 *    matches author expectations for schema-authoring workflows.
 *  - The PATCH body sends only changed properties, so a save on a row
 *    with one-column change doesn't send the whole row back.
 */
interface Props {
  itemId: string;
  layer: DataLayerSublayer;
  /** Full sibling layer list -- enables the Export menu's bundle
   *  option to include related tables.  Optional so the component
   *  still works in isolation (the export menu just hides the
   *  bundle option in that case). */
  allLayers?: DataLayerSublayer[];
  canEdit: boolean;
  /** Download tier (#32). When false the export menu (CSV / XLSX /
   *  GeoJSON / GeoParquet / bundle) is hidden entirely: the server
   *  now 403s the bulk endpoints for these callers, and offering
   *  client-built exports of the loaded page would make the UI
   *  disagree with the policy. */
  canDownload: boolean;
  onRefreshCounts?: () => void;
}

export function V3FeatureBrowser({
  itemId,
  layer,
  allLayers,
  canEdit,
  canDownload,
  onRefreshCounts,
}: Props) {
  const [features, setFeatures] = useState<FeatureRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirm();
  const [attachmentsOpenFor, setAttachmentsOpenFor] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const fields = layer.fields ?? [];

  /**
   * How many rows the inline browser fetches per open. The
   * underlying server endpoint caps at 5000; we ask for the cap
   * so any layer up to that size loads in one shot, larger
   * layers truncate with a banner pointing the user at the map
   * editor for full-table workflows.
   *
   * Previously the browser hit /features (full GeoJSON, default
   * limit 100,000) which hung the portal on a 1.4M-row WV
   * Parcels layer (#72). /features-page strips geometry server-
   * side and caps response size, making the inline editor safe
   * to open on any layer regardless of feature count.
   */
  const PAGE_LIMIT = 5000;

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features-page?limit=${PAGE_LIMIT}`,
      );
      if (!res.ok) {
        setError(`Could not load features: ${res.status} ${await res.text()}`);
        return;
      }
      const body = (await res.json()) as {
        features: FeatureRecord[];
        count: number;
        truncated: boolean;
      };
      setFeatures(body.features ?? []);
      setTruncated(Boolean(body.truncated));
    } catch (err) {
      setError((err as Error).message || 'Could not load features');
    } finally {
      setLoading(false);
    }
  }, [itemId, layer.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startEdit(feature: FeatureRecord) {
    setEditingId(feature.id);
    setDraft({ ...(feature.properties ?? {}) });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft({});
  }

  async function saveEdit() {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features/${editingId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ properties: draft }),
        },
      );
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setEditingId(null);
      setDraft({});
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function remove(feature: FeatureRecord) {
    const ok = await confirm({
      title: 'Delete this feature?',
      message:
        'This writes a tombstone (soft delete): the feature disappears from current queries but history is preserved.',
      variant: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setError(null);
    const res = await fetch(
      `/api/portal/items/${itemId}/layers/${layer.id}/features/${feature.id}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setError(`Delete failed: ${res.status}`);
      return;
    }
    await reload();
    onRefreshCounts?.();
  }

  async function addBlank() {
    setAdding(true);
    setError(null);
    try {
      // Blank geometry + empty properties: authors fill in fields in
      // the row's edit view, and the geometry via the map editor if
      // the layer is spatial.
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: [{ properties: {} }] }),
        },
      );
      if (!res.ok) {
        setError(`Add row failed: ${res.status} ${await res.text()}`);
        return;
      }
      await reload();
      onRefreshCounts?.();
    } finally {
      setAdding(false);
    }
  }

  const columnKeys = useMemo(() => {
    // Column order = declared field order, then any extra keys seen on
    // features (in insertion order) so unregistered fields still show.
    // Skip underscore-prefixed system metadata (_global_id,
    // _created_by, _created_at, _edited_by, _edited_at): the api
    // inlines those for popup/attribute-footer use, but they're
    // noise in the browse table -- the user sees raw UUIDs and the
    // gid column already covers row identity. The Esri convention is
    // a separate metadata panel for these; we already have one in
    // the popup metadata footer. See task #39.
    const declared = new Set(fields.map((f) => f.name));
    const extras = new Set<string>();
    for (const f of features) {
      for (const k of Object.keys(f.properties ?? {})) {
        if (k.startsWith('_')) continue;
        if (!declared.has(k)) extras.add(k);
      }
    }
    return [...fields.map((f) => f.name), ...extras];
  }, [fields, features]);

  const fieldByName = useMemo(() => {
    const map = new Map<string, FeatureField>();
    for (const f of fields) map.set(f.name, f);
    return map;
  }, [fields]);

  return (
    <div className="mt-2 rounded-md border border-border bg-surface-0">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">
          Features
          {loading ? '' : ` · ${features.length}`}
        </p>
        <div className="flex items-center gap-1">
          {canEdit ? (
            <button
              type="button"
              onClick={addBlank}
              disabled={adding}
              className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {adding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add row
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
          {/* #107: export current feature set to CSV / XLSX.  Uses
              whatever's already loaded in `features` so there's no
              extra round-trip; matches what the table is showing.
              Hidden outright without the download tier (#32): the
              server 403s the bulk endpoints for those callers and a
              visible-but-doomed menu would just be a trap. */}
          {canDownload ? (
            <ExportMenu
              itemId={itemId}
              features={features}
              layer={layer}
              {...(allLayers ? { allLayers } : {})}
              disabled={loading || features.length === 0}
            />
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-border bg-danger/5 px-3 py-1.5 text-2xs text-danger">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {truncated ? (
        <div className="flex items-start gap-1.5 border-b border-border bg-warning/5 px-3 py-1.5 text-2xs text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Showing the first {PAGE_LIMIT.toLocaleString()} rows. This layer
            has more than that; open it in the map editor for the full feature
            set or use the Export button for the complete table.
          </span>
        </div>
      ) : null}

      {loading ? (
        <p className="px-3 py-6 text-center text-xs text-muted">
          Loading features…
        </p>
      ) : features.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted">
          No features yet. Import a file or add a blank row.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-2xs">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">#</th>
                {columnKeys.map((k) => (
                  <th
                    key={k}
                    className="whitespace-nowrap px-2 py-1 text-left font-medium"
                    title={fieldByName.get(k)?.label ?? k}
                  >
                    {fieldByName.get(k)?.label || k}
                    <span className="ml-1 text-2xs uppercase text-muted">
                      {fieldByName.get(k)?.type ?? ''}
                    </span>
                  </th>
                ))}
                {canEdit ? (
                  <th className="sticky right-0 bg-surface-2 px-2 py-1 text-right font-medium">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {features.map((f) => {
                const isEditing = editingId === f.id;
                return (
                  <tr key={f.id} className="border-t border-border">
                    <td
                      className="px-2 py-1 font-mono text-2xs text-muted"
                      title={f.id}
                    >
                      {f._meta?.gid ?? f.id.slice(0, 6)}
                    </td>
                    {columnKeys.map((k) => {
                      const field = fieldByName.get(k);
                      const raw = isEditing
                        ? draft[k]
                        : f.properties?.[k];
                      return (
                        <td
                          key={k}
                          className="whitespace-nowrap px-2 py-1 align-top"
                        >
                          {isEditing ? (
                            <FieldEditor
                              field={field}
                              name={k}
                              value={raw}
                              onChange={(v) =>
                                setDraft((prev) => ({ ...prev, [k]: v }))
                              }
                            />
                          ) : (
                            <span className="text-ink-1">
                              {formatCellValue(raw)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    {canEdit || layer.attachmentsEnabled ? (
                      <td className="sticky right-0 bg-surface-0 px-2 py-1 text-right">
                        <div className="inline-flex items-center gap-0.5">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void saveEdit()}
                                disabled={saving}
                                title="Save"
                                className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-accent hover:bg-accent/10 disabled:opacity-50"
                              >
                                {saving ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Save className="h-3 w-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={saving}
                                title="Cancel"
                                className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 disabled:opacity-50"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              {layer.attachmentsEnabled ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAttachmentsOpenFor((prev) =>
                                      prev === f.id ? null : f.id,
                                    )
                                  }
                                  title="Attachments"
                                  className={`inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 ${
                                    attachmentsOpenFor === f.id
                                      ? 'text-accent'
                                      : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                                  }`}
                                >
                                  <Paperclip className="h-3 w-3" />
                                </button>
                              ) : null}
                              {canEdit ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startEdit(f)}
                                    title="Edit"
                                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void remove(f)}
                                    title="Delete"
                                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-danger/10 hover:text-danger"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {/* Render the attachments panel in its own row below the
                   feature whose panel is open, so the gallery has room
                   to breathe without squeezing the table. */}
              {attachmentsOpenFor &&
              features.some((f) => f.id === attachmentsOpenFor) ? (
                <tr>
                  <td
                    colSpan={
                      1 +
                      columnKeys.length +
                      (canEdit || layer.attachmentsEnabled ? 1 : 0)
                    }
                    className="border-t border-border bg-surface-1 px-3 py-2"
                  >
                    <V3FeatureAttachments
                      itemId={itemId}
                      layerId={layer.id}
                      featureId={attachmentsOpenFor}
                      canEdit={canEdit}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {features.length > 0 && canEdit ? (
        <footer className="flex items-center gap-1 border-t border-border bg-surface-1 px-3 py-1.5 text-2xs text-muted">
          <Check className="h-3 w-3" />
          Edits save to the feature table; history is preserved via the
          temporal valid_from/valid_to pattern.
        </footer>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * #107: Export-this-layer dropdown.  CSV + XLSX are built client-
 * side from the already-loaded feature set.  Geometry rides along
 * as a `geometry_wkt` column on XLSX so the user can round-trip
 * into desktop GIS without losing shape; CSV stays text-only by
 * convention.
 *
 * Why "what's loaded" instead of always re-fetching: the feature
 * browser loads the whole layer on open (capped at whatever the
 * features endpoint returns), so the table view IS the canonical
 * dataset for this layer.  Exporting that exact set means "what
 * you see is what you get" -- if the cap matters the table also
 * shows it.  Bundle export (related tables + attachments) is the
 * follow-up that needs a server-side ZIP endpoint.
 *
 * GeoParquet (#174) is the exception to the client-side rule: the
 * server walks the FULL layer (no table cap) and writes a typed
 * GeoParquet file via DuckDB.  It is also the first surface gated
 * on the download share tier; a view-only share gets a 403 that we
 * surface as a toast, matching how the other entries let the
 * server govern access.
 */
function ExportMenu({
  itemId,
  features,
  layer,
  allLayers,
  disabled,
}: {
  itemId: string;
  features: FeatureRecord[];
  layer: DataLayerSublayer;
  allLayers?: DataLayerSublayer[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Bundle export modal state.  Lives inside the menu so the menu
  // can collapse while the modal stays up; "Export" -> Bundle
  // opens the modal in a fresh state every time.
  const [bundleOpen, setBundleOpen] = useState(false);
  const [bundleIncludeRelated, setBundleIncludeRelated] = useState(true);
  const [bundleIncludeAttachments, setBundleIncludeAttachments] = useState(true);
  const [bundlePrefixField, setBundlePrefixField] = useState<string>('');
  const [bundleSplitField, setBundleSplitField] = useState<string>('');
  const [bundleRunning, setBundleRunning] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<string>('');
  const [bundleError, setBundleError] = useState<string | null>(null);
  // Server round-trip in flight for the GeoParquet entry; used to
  // debounce re-clicks while the layer is being written.
  const [parquetRunning, setParquetRunning] = useState(false);

  // Related tables = sibling layers whose parentLayerId points at
  // THIS layer.  Used to gate the "Include related" toggle so the
  // checkbox doesn't appear when there's nothing to include.
  const relatedLayerCount = (allLayers ?? []).filter(
    (l) => l.parentLayerId === layer.id,
  ).length;

  /**
   * GeoParquet goes through the server (full layer, typed columns,
   * real geo metadata) rather than the client-side writers below.
   * Failures surface as a toast; the interesting one is the 403 a
   * view-only share receives from the endpoint's download gate.
   */
  async function runGeoParquet(): Promise<void> {
    setOpen(false);
    if (parquetRunning) return;
    setParquetRunning(true);
    try {
      await exportLayerGeoParquet({
        itemId,
        layerId: layer.id,
        filename: sanitizeFilename(layer.label || layer.name || 'layer'),
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'GeoParquet export failed',
      );
    } finally {
      setParquetRunning(false);
    }
  }

  function run(format: ClientExportFormat): void {
    setOpen(false);
    if (features.length === 0) return;
    const filename = sanitizeFilename(layer.label || layer.name || 'layer');
    exportFeatures(
      features.map((f) => ({
        id: f.id,
        geometry: f.geometry,
        properties: f.properties ?? null,
      })),
      format,
      {
        filename,
        fields: (layer.fields ?? []).map((fld) => ({
          name: fld.name,
          ...(fld.label && fld.label !== fld.name ? { label: fld.label } : {}),
        })),
        // XLSX gets the WKT geometry column for desktop-GIS round-
        // trip; CSV stays text-only (the most common downstream
        // consumer, Excel for casual edits, doesn't know WKT and
        // the column would just clutter the view).
        includeGeometryWkt: format === 'xlsx',
      },
    );
  }

  async function runBundle(): Promise<void> {
    setBundleError(null);
    setBundleRunning(true);
    setBundleProgress('Starting…');
    try {
      const result = await exportBundle({
        itemId,
        layerKey: layer.id,
        filename: sanitizeFilename(layer.label || layer.name || 'layer'),
        // Map shared-type's DataLayerSublayer down to the lighter
        // BundleSublayer the helper expects.  Only the fields the
        // bundle needs come through; this also defends against the
        // helper accidentally relying on properties that aren't
        // stable across the data_layer's lifetime.
        layers: (allLayers ?? []).map((l) => ({
          id: l.id,
          label: l.label,
          name: l.name,
          fields: (l.fields ?? []).map((f) => ({
            name: f.name,
            ...(f.label && f.label !== f.name ? { label: f.label } : {}),
          })),
          ...(l.parentLayerId ? { parentLayerId: l.parentLayerId } : {}),
        })),
        includeRelatedTables: bundleIncludeRelated && relatedLayerCount > 0,
        includeAttachments: bundleIncludeAttachments,
        ...(bundlePrefixField
          ? { attachmentPrefixField: bundlePrefixField }
          : {}),
        ...(bundleSplitField
          ? { attachmentSplitField: bundleSplitField }
          : {}),
        onProgress: (msg) => setBundleProgress(msg),
      });
      setBundleProgress(
        `Done -- ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'} · ${result.featureCount} feature${result.featureCount === 1 ? '' : 's'} · ${result.attachmentCount} attachment${result.attachmentCount === 1 ? '' : 's'} · ${(result.bytes / 1024 / 1024).toFixed(1)} MB`,
      );
      // Close the modal after a short delay so the user sees the
      // "Done" confirmation; their browser is in the middle of the
      // download dialog at this point.
      setTimeout(() => {
        setBundleOpen(false);
        setBundleRunning(false);
      }, 1500);
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
      setBundleRunning(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        title={
          features.length === 0
            ? 'No features to export'
            : `Export ${features.length} feature(s)`
        }
      >
        <Download className="h-3 w-3" />
        Export
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-8 z-40 w-56 rounded-md border border-border bg-surface-0 py-1 text-xs shadow-lg">
            <button
              type="button"
              onClick={() => run('xlsx')}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => run('csv')}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              CSV
            </button>
            <button
              type="button"
              onClick={() => void runGeoParquet()}
              disabled={parquetRunning}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50"
            >
              {parquetRunning ? 'GeoParquet (preparing…)' : 'GeoParquet'}
            </button>
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              // Bound to the Bundle-export help doc (#118).  Picking
              // this control in the help drawer opens the "Bundle
              // export" page covering what the .zip contains and
              // when to use it vs. CSV / XLSX.
              data-help="bundle-export-button"
              onClick={() => {
                setOpen(false);
                setBundleOpen(true);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              Bundle (.zip): Excel + related + attachments
            </button>
          </div>
        </>
      ) : null}

      {bundleOpen ? (
        <BundleExportModal
          layer={layer}
          relatedLayerCount={relatedLayerCount}
          includeRelated={bundleIncludeRelated}
          setIncludeRelated={setBundleIncludeRelated}
          includeAttachments={bundleIncludeAttachments}
          setIncludeAttachments={setBundleIncludeAttachments}
          prefixField={bundlePrefixField}
          setPrefixField={setBundlePrefixField}
          splitField={bundleSplitField}
          setSplitField={setBundleSplitField}
          running={bundleRunning}
          progress={bundleProgress}
          error={bundleError}
          onCancel={() => {
            if (bundleRunning) return;
            setBundleOpen(false);
          }}
          onRun={() => void runBundle()}
        />
      ) : null}
    </div>
  );
}

/**
 * Bundle export options modal.  Two toggles + two optional field
 * pickers + a progress line.  Stays simple by default; field
 * pickers are surfaced only when there's a likely-useful field to
 * pick (a string-ish attribute on the parent layer).
 */
function BundleExportModal({
  layer,
  relatedLayerCount,
  includeRelated,
  setIncludeRelated,
  includeAttachments,
  setIncludeAttachments,
  prefixField,
  setPrefixField,
  splitField,
  setSplitField,
  running,
  progress,
  error,
  onCancel,
  onRun,
}: {
  layer: DataLayerSublayer;
  relatedLayerCount: number;
  includeRelated: boolean;
  setIncludeRelated: (v: boolean) => void;
  includeAttachments: boolean;
  setIncludeAttachments: (v: boolean) => void;
  prefixField: string;
  setPrefixField: (v: string) => void;
  splitField: string;
  setSplitField: (v: string) => void;
  running: boolean;
  progress: string;
  error: string | null;
  onCancel: () => void;
  onRun: () => void;
}) {
  // Pickable string-ish fields on the parent layer.  Used for the
  // attachment-prefix and attachment-split dropdowns.  Numeric
  // fields are allowed too since IDs are often numeric.
  const pickableFields = (layer.fields ?? []).filter((f) => {
    const t = (f as { type?: string }).type ?? 'text';
    return t === 'text' || t === 'integer' || t === 'double' || t === 'bigint';
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={running ? undefined : onCancel}
    >
      <div
        className="relative w-full max-w-md rounded-lg bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-ink-0">Bundle export</h3>
          <p className="mt-1 text-xs text-muted">
            Pack {layer.label || layer.name} (and optionally its related
            tables + feature attachments) into a single ZIP.
          </p>
        </header>
        <div className="space-y-3 px-4 py-3 text-xs">
          {relatedLayerCount > 0 ? (
            <label className="flex items-start gap-2 text-ink-1">
              <input
                type="checkbox"
                disabled={running}
                checked={includeRelated}
                onChange={(e) => setIncludeRelated(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Include {relatedLayerCount} related table
                {relatedLayerCount === 1 ? '' : 's'} as sheet
                {relatedLayerCount === 1 ? '' : 's'} in the same workbook.
              </span>
            </label>
          ) : (
            <p className="text-muted">
              No related tables found on this layer.
            </p>
          )}
          <label className="flex items-start gap-2 text-ink-1">
            <input
              type="checkbox"
              disabled={running}
              checked={includeAttachments}
              onChange={(e) => setIncludeAttachments(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Include feature attachments under <code>attachments/</code>.
              Off if you only need the spreadsheet.
            </span>
          </label>
          {includeAttachments ? (
            <>
              <div>
                <label className="block text-2xs font-medium uppercase tracking-wide text-muted">
                  Attachment filename prefix (optional)
                </label>
                <select
                  disabled={running}
                  value={prefixField}
                  onChange={(e) => setPrefixField(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1 text-sm"
                >
                  <option value="">(use feature ID)</option>
                  {pickableFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label || f.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-2xs text-muted">
                  When set, each attachment&apos;s filename starts with
                  this field&apos;s value -- matches the convention
                  used by the ArcGIS Pro export script.
                </p>
              </div>
              <div>
                <label className="block text-2xs font-medium uppercase tracking-wide text-muted">
                  Organize attachments by field (optional)
                </label>
                <select
                  disabled={running}
                  value={splitField}
                  onChange={(e) => setSplitField(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1 text-sm"
                >
                  <option value="">(single attachments folder)</option>
                  {pickableFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label || f.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-2xs text-muted">
                  Each attachment lands in a subfolder named for this
                  field&apos;s value (eg <code>Site A/</code>).
                </p>
              </div>
            </>
          ) : null}
        </div>
        {progress || error ? (
          <div
            className={`mx-4 mb-3 rounded-md border px-3 py-2 text-2xs ${
              error
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-border bg-surface-2 text-ink-1'
            }`}
          >
            {error ?? progress}
          </div>
        ) : null}
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            disabled={running}
            onClick={onCancel}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Close
          </button>
          <button
            type="button"
            disabled={running}
            onClick={onRun}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {running ? 'Building…' : 'Export bundle'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Trim a label down to a safe filename root.  Keeps letters /
 *  digits / underscores / hyphens / dots, replaces everything else
 *  with `_`, and caps the length so we don't trip Windows path
 *  limits with a 200-char layer name. */
function sanitizeFilename(raw: string): string {
  const s = raw.trim().replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  return (s.slice(0, 60) || 'layer').replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------

/** Render a typed editor input based on the declared field type.
 *  Unknown / legacy columns fall back to text. */
function FieldEditor({
  field,
  name,
  value,
  onChange,
}: {
  field: FeatureField | undefined;
  name: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const kind = field?.type ?? 'string';
  const stringValue = value === null || value === undefined ? '' : String(value);

  if (kind === 'boolean') {
    const checked = value === true || value === 'true';
    return (
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border"
      />
    );
  }

  if (kind === 'number') {
    return (
      <input
        type="number"
        value={stringValue}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        className="h-6 w-24 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    );
  }

  if (kind === 'date') {
    // Accept both date-only (YYYY-MM-DD) and full ISO. Keep whatever
    // precision the backend already stored: parse/serialize naively.
    const dateVal =
      typeof value === 'string' ? value.slice(0, 10) : '';
    return (
      <input
        type="date"
        value={dateVal}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-6 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    );
  }

  // string + domain: render a select when coded-value domain is set.
  if (kind === 'string' && field?.domain?.type === 'coded-value') {
    return (
      <select
        value={stringValue}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-6 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      >
        <option value="">-</option>
        {field.domain.values.map((v) => (
          <option key={String(v.code)} value={String(v.code)}>
            {v.label || String(v.code)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type="text"
      value={stringValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder={name}
      className="h-6 w-40 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
    />
  );
}

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
