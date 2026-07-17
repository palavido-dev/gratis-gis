// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  FlaskConical,
  Plus,
  Table2,
  Upload,
} from 'lucide-react';
import type { DataLayerSublayer } from '@gratis-gis/shared-types';
import {
  UploadProgressPanel,
  uploadWithProgress,
  type UploadBusy,
} from '@/components/upload-progress-panel';
import { V3FeatureBrowser } from './v3-feature-browser';

// Analyze (#175) lazy-loads: the DuckDB-WASM chunk is multiple MB
// and must cost nothing on detail pages where nobody analyzes.
// ssr:false because the module boots a Worker at first use.
const LayerAnalyzePanel = dynamic(
  () => import('./layer-analyze-panel').then((m) => m.LayerAnalyzePanel),
  { ssr: false },
);

/**
 * Per-layer data panel for a v3 data_layer item on the detail
 * page. Lists each layer with an "Import features" button that POSTs
 * a spatial file to /items/:id/layers/:layerId/import. The server's
 * ingest controller parses via GDAL and bulk-inserts into the layer's
 * PostGIS table (Phase C).
 *
 * Multi-layer archive (GDB, shapefile zip with multiple .shp) flow:
 * this component shows a single file picker per target layer. If the
 * user uploads a multi-layer archive, the server currently returns a
 * 400 asking for ?sourceLayer=<name>. A follow-up can add a
 * preview-first probe step; for MVP authors can use the Import tab
 * in the builder to add layers, then import data per-layer from a
 * file that has just that one layer.
 */
interface Props {
  itemId: string;
  layers: DataLayerSublayer[];
  canEdit: boolean;
  /** Download tier (#32); hides the feature browser's export
   *  affordances for view-only shares. */
  canDownload: boolean;
}

export function V3LayerDataPanel({ itemId, layers, canEdit, canDownload }: Props) {
  if (layers.length === 0) {
    return null;
  }
  return (
    <section className="rounded-lg border border-border bg-surface-1">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Database className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-semibold text-ink-0">Layer data</h2>
        <p className="text-xs text-muted">
          Import spatial data into any layer.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {layers.map((layer) => (
          <LayerRow
            key={layer.id}
            itemId={itemId}
            layer={layer}
            allLayers={layers}
            canEdit={canEdit}
            canDownload={canDownload}
          />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface RowProps {
  itemId: string;
  layer: DataLayerSublayer;
  /** Full sibling layer list -- threaded down so the feature
   *  browser's Export menu can offer a bundle that includes
   *  related tables (#109). */
  allLayers: DataLayerSublayer[];
  canEdit: boolean;
  canDownload: boolean;
}

function LayerRow({ itemId, layer, allLayers, canEdit, canDownload }: RowProps) {
  const router = useRouter();
  // Busy carries the prominent upload-progress state. The previous
  // tiny inline spinner on the Import features button was easy to
  // miss while a 200 MB shapefile uploaded; now the row expands to
  // show file name, file size, real upload bytes, and a phase label
  // that flips through Uploading X% / Importing features so the user
  // can see what's happening at every step.
  const [busy, setBusy] = useState<UploadBusy | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [message, setMessage] = useState<
    | { kind: 'success'; text: string }
    | { kind: 'error'; text: string }
    | null
  >(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  // #248: remember which import mode the user chose when they opened
  // the file picker. The native <input type="file"> dialog can't carry
  // arbitrary state in its onChange event, so we stash the mode on a
  // ref and read it back when the file is selected. Defaults to
  // 'replace' so an unexpected open (e.g. system shortcut) still
  // produces a safe re-import.
  const pendingModeRef = useRef<'replace' | 'append'>('replace');

  function cancelUpload() {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setBusy(null);
    setMessage(null);
  }

  // #248: import mode threaded through handleFile. Default is replace
  // (the safe re-import-the-truth flow from #244). Append is opt-in
  // via the split-button dropdown -- mostly useful when stitching
  // monthly drops into a growing layer or merging two source files
  // with non-overlapping content.
  async function handleFile(file: File, mode: 'replace' | 'append') {
    setMessage(null);
    setBusy({
      phase: 'uploading',
      fileName: file.name,
      fileSize: file.size,
      bytesUploaded: 0,
      // Subhead copy is tuned for the ingest phase (PostGIS bulk
      // insert, possibly hundreds of thousands of rows) rather than
      // the wizard's "GDAL is listing layers" probe phase.
      copy: {
        reading: {
          headline: mode === 'append' ? 'Appending features' : 'Importing features',
          subhead:
            mode === 'append'
              ? 'Parsing the file and inserting into PostGIS alongside existing rows. Large layers can take a few minutes.'
              : 'Parsing the file and bulk-inserting into PostGIS. Large layers (county-scale parcels) can take a few minutes.',
        },
      },
    });
    try {
      // #244: replace is the default; #248: append is the opt-in
      // split-button dropdown choice. The endpoint accepts both; we
      // just forward whichever mode the caller picked.
      const out = await uploadWithProgress<{
        driver: string;
        sourceLayer: string;
        inserted: number;
        mode: 'replace' | 'append';
        replaced?: number;
      }>(
        `/api/portal/items/${itemId}/layers/${layer.id}/import?mode=${mode}`,
        file,
        (e) => {
          setBusy((prev) =>
            prev
              ? { ...prev, phase: e.phase, bytesUploaded: e.bytesUploaded }
              : null,
          );
        },
        xhrRef,
      );
      xhrRef.current = null;
      const replacedSuffix =
        out.mode === 'replace' && typeof out.replaced === 'number' && out.replaced > 0
          ? ` (replaced ${out.replaced.toLocaleString()})`
          : '';
      setMessage({
        kind: 'success',
        text: `${out.inserted.toLocaleString()} feature${
          out.inserted === 1 ? '' : 's'
        } ${out.mode === 'append' ? 'appended' : 'imported'} from ${out.sourceLayer} (${out.driver})${replacedSuffix}`,
      });
      // Refresh the server-rendered detail page so featureCount /
      // bbox on the header match the new state.
      router.refresh();
    } catch (err) {
      // Cancellations come through here; don't tag those as errors.
      if ((err as Error).name === 'AbortError') {
        // No-op; cancelUpload already cleared state.
      } else {
        setMessage({
          kind: 'error',
          text: (err as Error).message || 'Upload failed',
        });
      }
    } finally {
      setBusy(null);
      xhrRef.current = null;
    }
  }

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-0">
            {layer.label}
          </p>
          <p className="text-2xs text-muted">
            <span className="uppercase">
              {layer.geometryType ?? 'table'}
            </span>
            {' · '}
            <span className="font-mono">{layer.name}</span>
            {typeof layer.featureCount === 'number' ? (
              <>
                {' · '}
                {layer.featureCount.toLocaleString()} feature
                {layer.featureCount === 1 ? '' : 's'}
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBrowseOpen((v) => !v)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
          title={browseOpen ? 'Hide features' : 'Browse & edit features'}
        >
          {browseOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Table2 className="h-3.5 w-3.5" />
          {browseOpen ? 'Hide' : 'Browse'}
        </button>
        {/* Analyze (#175): in-browser SQL over the layer. Gated on
            the download tier because the panel pulls the full layer
            through the GeoParquet export endpoint, which 403s
            without it; hiding beats offering a doomed button. */}
        {canDownload ? (
          <button
            type="button"
            onClick={() => setAnalyzeOpen((v) => !v)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
            title={
              analyzeOpen
                ? 'Hide analysis'
                : 'Analyze with SQL, in your browser'
            }
          >
            <FlaskConical className="h-3.5 w-3.5" />
            Analyze
          </button>
        ) : null}
        {canEdit ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".geojson,.json,.parquet,.geoparquet,.kml,.kmz,.zip,.gdb"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f, pendingModeRef.current);
                e.target.value = '';
              }}
            />
            <ImportButtonCluster
              hasFeatures={(layer.featureCount ?? 0) > 0}
              busy={busy !== null}
              onPickFile={(mode) => {
                pendingModeRef.current = mode;
                inputRef.current?.click();
              }}
            />
          </>
        ) : null}
      </div>
      {busy ? (
        <div className="mt-2">
          <UploadProgressPanel busy={busy} onCancel={cancelUpload} />
        </div>
      ) : null}
      {message ? (
        <p
          role={message.kind === 'error' ? 'alert' : undefined}
          className={`mt-1.5 inline-flex items-center gap-1 text-2xs ${
            message.kind === 'error' ? 'text-danger' : 'text-success'
          }`}
        >
          {message.kind === 'error' ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {message.text}
        </p>
      ) : null}
      {analyzeOpen ? (
        <LayerAnalyzePanel itemId={itemId} layer={layer} />
      ) : null}
      {browseOpen ? (
        <V3FeatureBrowser
          itemId={itemId}
          layer={layer}
          allLayers={allLayers}
          canEdit={canEdit}
          canDownload={canDownload}
          onRefreshCounts={() => router.refresh()}
        />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------

/**
 * #248: Import features button cluster. When the layer is empty
 * (featureCount === 0 or unknown) it's a single button -- replace
 * and append are equivalent on an empty table, so the dropdown
 * would just be noise. Once the layer has any rows the cluster
 * grows a chevron that opens a small menu offering "Append instead",
 * with replace remaining the default action of the main button.
 *
 * The cluster owns the menu open/close state but the file picker
 * itself + the upload-mode ref live in the parent LayerRow -- one
 * <input type="file"> covers both modes via pendingModeRef. Keeps
 * this component small + stateless beyond the chevron toggle.
 */
function ImportButtonCluster({
  hasFeatures,
  busy,
  onPickFile,
}: {
  hasFeatures: boolean;
  busy: boolean;
  onPickFile: (mode: 'replace' | 'append') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click so the menu doesn't linger after the user
  // drifts away. mousedown rather than click so the menu shuts before
  // a tap on the canvas registers as a click somewhere else.
  useEffect(() => {
    if (!menuOpen) return undefined;
    function onDoc(e: MouseEvent) {
      if (!menuRootRef.current) return;
      if (menuRootRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  if (!hasFeatures) {
    return (
      <button
        type="button"
        onClick={() => onPickFile('replace')}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        <Upload className="h-3.5 w-3.5" />
        Import features
      </button>
    );
  }

  return (
    <div ref={menuRootRef} className="relative inline-flex">
      {/* Main button = replace (the default since #244). The
          chevron sits flush to its right and opens the alternate-mode
          menu. Border treatment matches button-group conventions:
          the main button's right edge is squared, the chevron's left
          edge is squared, so the two read as one widget. */}
      <button
        type="button"
        onClick={() => onPickFile('replace')}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-l-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        title="Replace existing features with the contents of a new file"
      >
        <Upload className="h-3.5 w-3.5" />
        Import features
      </button>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={busy}
        aria-label="More import options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="inline-flex h-8 items-center justify-center rounded-r-md border border-l-0 border-border bg-surface-1 px-1 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-56 rounded-md border border-border bg-surface-1 p-1 text-xs shadow-overlay"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onPickFile('append');
            }}
            className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2"
          >
            <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink-0">
                Append instead
              </span>
              <span className="block text-2xs text-muted">
                Add the new file&apos;s features alongside the existing rows.
              </span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
