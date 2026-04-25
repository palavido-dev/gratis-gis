'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Table2,
  Upload,
} from 'lucide-react';
import type { DataLayerSublayer } from '@gratis-gis/shared-types';
import { V3FeatureBrowser } from './v3-feature-browser';

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
}

export function V3LayerDataPanel({ itemId, layers, canEdit }: Props) {
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
            canEdit={canEdit}
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
  canEdit: boolean;
}

function LayerRow({ itemId, layer, canEdit }: RowProps) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [message, setMessage] = useState<
    | { kind: 'success'; text: string }
    | { kind: 'error'; text: string }
    | null
  >(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setMessage(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/import`,
        { method: 'POST', body },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setMessage({
          kind: 'error',
          text: `Import failed (${res.status}): ${
            text || res.statusText || 'no body'
          }`,
        });
        return;
      }
      const out = (await res.json()) as {
        driver: string;
        sourceLayer: string;
        inserted: number;
      };
      setMessage({
        kind: 'success',
        text: `${out.inserted.toLocaleString()} feature${
          out.inserted === 1 ? '' : 's'
        } imported from ${out.sourceLayer} (${out.driver})`,
      });
      // Refresh the server-rendered detail page so featureCount /
      // bbox on the header match the new state next time Phase C
      // hooks those back into item.data.
      router.refresh();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: (err as Error).message || 'Upload failed',
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-0">
            {layer.label}
          </p>
          <p className="text-[11px] text-muted">
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
        {canEdit ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".geojson,.json,.kml,.kmz,.zip,.gdb"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Import features
            </button>
          </>
        ) : null}
      </div>
      {message ? (
        <p
          role={message.kind === 'error' ? 'alert' : undefined}
          className={`mt-1.5 inline-flex items-center gap-1 text-[11px] ${
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
      {browseOpen ? (
        <V3FeatureBrowser
          itemId={itemId}
          layer={layer}
          canEdit={canEdit}
          onRefreshCounts={() => router.refresh()}
        />
      ) : null}
    </li>
  );
}
