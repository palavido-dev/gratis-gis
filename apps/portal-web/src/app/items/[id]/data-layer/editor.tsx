'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronRight,
  ClipboardPaste,
  FileArchive,
  Loader2,
  MapPin,
  Save,
  Upload,
} from 'lucide-react';
import type {
  FeatureField,
  DataLayerData,
  DataLayerDataV1,
  DataLayerDataV2,
  DataLayerDataV3,
  ISODateString,
} from '@gratis-gis/shared-types';
import {
  detectFormat,
  importSpatialFile,
  type SpatialFormat,
  type SpatialImportResult,
} from '@/lib/spatial-import';
import { DataLayerBboxPreview } from './bbox-preview';

interface Props {
  itemId: string;
  initial: DataLayerData;
  canEdit: boolean;
}

type Tab = 'upload' | 'paste';

function isV2(data: DataLayerData): data is DataLayerDataV2 {
  return data.version === 2 && (data as DataLayerDataV2).storageType === 'postgis';
}

function isV3(data: DataLayerData): data is DataLayerDataV3 {
  return data.version === 3;
}

/**
 * Feature-service data editor. Handles both v1 (inline GeoJSON) and v2
 * (PostGIS-backed) storage transparently:
 *
 * - v1: parses client-side, saves via PATCH /items/:id with full GeoJSON payload.
 * - v2: parses client-side, saves via POST /items/:id/features/import with the
 *       GeoJSON FeatureCollection. The server atomically replaces all features
 *       and updates item metadata.
 *
 * Server-side GDAL ingest (File Geodatabase etc.) routes via POST /items/:id/ingest
 * for both storage types.
 */
export function DataLayerEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('upload');
  const [staged, setStaged] = useState<SpatialImportResult | null>(null);
  const [paste, setPaste] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const v2 = isV2(initial);
  const v3 = isV3(initial);

  // v3 is multi-layer: this single-layer editor surfaces aggregated
  // stats and the fields of the first layer. The dedicated multi-layer
  // editor (Phase B+) is the proper home for v3 editing; this block is
  // a compatibility bridge so the existing ingest flows still compile.
  const currentFeatureCount = v3
    ? (initial as DataLayerDataV3).layers.reduce(
        (sum, l) => sum + (l.featureCount ?? 0),
        0,
      )
    : v2
      ? (initial as DataLayerDataV2).featureCount
      : ((initial as DataLayerDataV1).data?.features?.length ?? 0);
  const currentFields: FeatureField[] = v3
    ? ((initial as DataLayerDataV3).layers[0]?.fields ?? [])
    : (initial as DataLayerDataV1 | DataLayerDataV2).fields;
  const currentUpdatedAt = initial.updatedAt;
  const currentBbox = v3
    ? ((initial as DataLayerDataV3).layers[0]?.bbox ?? null)
    : v2
      ? (initial as DataLayerDataV2).bbox
      : null;

  // Feature-source URLs for the preview (#35). v3 datasets fan out
  // one source per layer (each layer has its own backing PostGIS
  // table); v2 datasets ship a single source covering the whole
  // table. v1 has no server-side endpoint -- the inline-data preview
  // path could be added later but isn't worth the code today since
  // v1 layers are tiny and the bbox rectangle suffices. Empty list
  // -> the preview component falls back to the bbox-rectangle
  // rendering it always had.
  const previewSources: Array<{
    url: string;
    geometryType?: 'point' | 'line' | 'polygon' | null;
  }> = v3
    ? (initial as DataLayerDataV3).layers
        .filter((l) => (l.featureCount ?? 0) > 0)
        .map((l) => ({
          url: `/api/portal/items/${itemId}/layers/${l.id}/geojson`,
          geometryType: l.geometryType ?? null,
        }))
    : v2 && currentFeatureCount > 0
      ? [{ url: `/api/portal/items/${itemId}/geojson` }]
      : [];

  // Derived fields only needed for v1 (v2/v3 always store explicit fields).
  const v1Features =
    v2 || v3 ? [] : ((initial as DataLayerDataV1).data?.features ?? []);
  const derivedFields = useMemo<FeatureField[]>(
    () => (v2 ? [] : deriveFields(v1Features, 500)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v2],
  );

  async function importFile(file: File) {
    setError(null);
    setStaged(null);
    setPending(true);
    try {
      if (detectFormat(file.name) === 'fgdb') {
        await ingestServerSide(file);
        return;
      }
      const result = await importSpatialFile(file);
      setStaged(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setPending(false);
    }
  }

  /**
   * Server-side GDAL ingest: handles File Geodatabase and other formats
   * that have no in-browser parser. The ingest endpoint now writes directly
   * to PostGIS (provisioning the table on first use) and returns v2 metadata.
   */
  async function ingestServerSide(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/portal/items/${itemId}/ingest`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      setError(`Server ingest failed: ${res.status} ${text}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    router.refresh();
  }

  function applyPaste() {
    setError(null);
    setStaged(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { type?: string }).type !== 'FeatureCollection'
    ) {
      setError('Top-level object must be a GeoJSON FeatureCollection.');
      return;
    }
    const fc = parsed as GeoJSON.FeatureCollection;
    setStaged({
      geojson: fc,
      format: 'geojson',
      features: fc.features.length,
      warnings: [],
    });
  }

  async function save() {
    if (!staged) return;
    setError(null);
    setPending(true);
    try {
      if (v2) {
        // v2: POST the GeoJSON to the features/import endpoint. The server
        // atomically replaces all current features and updates item metadata.
        const res = await fetch(`/api/portal/items/${itemId}/features/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(staged.geojson),
        });
        if (!res.ok) {
          setError(`Save failed: ${res.status} ${await res.text()}`);
          return;
        }
      } else {
        // v1: PATCH item.data with the full inline GeoJSON payload.
        const nextData: DataLayerDataV1 = {
          version: 1,
          fields: deriveFields(
            staged.geojson.features as Array<{
              properties?: Record<string, unknown>;
            }>,
            500,
          ),
          data: staged.geojson as DataLayerDataV1['data'],
          updatedAt: new Date().toISOString() as ISODateString,
        };
        const res = await fetch(`/api/portal/items/${itemId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: nextData }),
        });
        if (!res.ok) {
          setError(`Save failed: ${res.status} ${await res.text()}`);
          return;
        }
      }

      setStaged(null);
      setPaste('');
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  function discard() {
    setStaged(null);
    setPaste('');
    setError(null);
  }

  const isEmpty = currentFeatureCount === 0;

  return (
    <div className="space-y-6">
      {isEmpty ? (
        <section className="rounded-lg border-2 border-dashed border-accent/40 bg-accent/5 p-5 text-center">
          <h3 className="text-base font-semibold text-ink-0">
            This feature service is empty
          </h3>
          <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
            Upload a file or paste GeoJSON below to get started.
            {v2 ? ' Features are stored in PostGIS with full version history.' : ''}
          </p>
        </section>
      ) : (
        <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Features
          </h3>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {currentFeatureCount.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-muted">
            Last updated{' '}
            {currentUpdatedAt
              ? new Date(currentUpdatedAt).toLocaleString()
              : 'never'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {v2 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                <MapPin className="h-3 w-3" />
                PostGIS, versioned
              </span>
            )}
            {v2 && currentBbox ? (
              <span className="text-[11px] text-muted">
                Extent: {currentBbox.map((n) => n.toFixed(4)).join(', ')}
              </span>
            ) : null}
          </div>
          {/* The field list used to live here as a chip row, but
              the Schema section below already lists every field
              with type / domain / constraints, so the chips were
              just duplicating that. Removed in #27. */}
          {currentBbox ? (
            <div className="mt-3">
              <DataLayerBboxPreview
                bbox={currentBbox}
                {...(previewSources.length > 0
                  ? { featureSources: previewSources }
                  : {})}
              />
            </div>
          ) : null}
        </section>
      )}

      {canEdit ? (
        <details
          id="add-data"
          // Open automatically only when the layer has no data yet
          // (the user came here to add some) or when an upload is
          // already staged for review. Otherwise stay collapsed: the
          // common visit to a data_layer is for inspection, and the
          // big upload UI used to dominate the fold.
          open={isEmpty || !!staged}
          className="scroll-mt-20 rounded-lg border border-border bg-surface-1 shadow-card [&[open]>summary>.add-data-chevron]:rotate-90"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="flex items-center gap-2">
              <span className="add-data-chevron text-muted transition-transform">
                <ChevronRight className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium">
                {isEmpty ? 'Add data' : 'Replace data'}
              </span>
            </span>
            <span className="text-[11px] text-muted">
              {isEmpty
                ? 'Upload a file or paste GeoJSON to populate this layer.'
                : 'Replace the whole dataset. Individual feature edits use the API.'}
            </span>
          </summary>

          <div className="flex gap-0 border-b border-border px-4 pt-2">
            <TabBtn
              Icon={Upload}
              label="Upload file"
              active={tab === 'upload'}
              onClick={() => setTab('upload')}
            />
            <TabBtn
              Icon={ClipboardPaste}
              label="Paste GeoJSON"
              active={tab === 'paste'}
              onClick={() => setTab('paste')}
            />
          </div>

          <div className="space-y-4 px-4 py-4">
            {tab === 'upload' ? (
              <>
                <FileDropZone busy={pending && !staged} onFile={importFile} />
                <div className="flex flex-wrap gap-1 text-[11px] text-muted">
                  <strong className="font-medium text-ink-1">Accepted:</strong>
                  <span>GeoJSON (.geojson/.json)</span>
                  <span>·</span>
                  <span>KML / KMZ</span>
                  <span>·</span>
                  <span>Shapefile (.zip bundle)</span>
                  <span>·</span>
                  <span>File Geodatabase (server-side GDAL)</span>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder='{"type":"FeatureCollection","features":[...]}'
                  rows={10}
                  className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={applyPaste}
                    disabled={!paste.trim()}
                    className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    Stage for save
                  </button>
                </div>
              </>
            )}

            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}

            {staged ? (
              <StagedReview
                staged={staged}
                saving={pending}
                saved={saved}
                onSave={save}
                onDiscard={discard}
              />
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function StagedReview({
  staged,
  saving,
  saved,
  onSave,
  onDiscard,
}: {
  staged: SpatialImportResult;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const fields = useMemo(
    () =>
      deriveFields(
        staged.geojson.features as Array<{
          properties?: Record<string, unknown>;
        }>,
        500,
      ),
    [staged],
  );
  const label = formatLabel(staged.format);

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-start gap-3">
        <FileArchive className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            Ready to save: {label} &middot;{' '}
            <span className="tabular-nums">{staged.features.toLocaleString()}</span>{' '}
            feature{staged.features === 1 ? '' : 's'}
          </div>
          <div className="mt-1">
            <FieldChips fields={fields} />
          </div>
          {staged.warnings.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-[11px] text-warn">
              {staged.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {saved ? (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            ) : null}
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save replacement
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileDropZone({
  busy,
  onFile,
}: {
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className={`flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
        over ? 'border-accent bg-accent/5' : 'border-border bg-surface-1'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      ) : (
        <Upload className="h-5 w-5 text-muted" />
      )}
      <p className="text-sm text-ink-1">
        {busy ? 'Parsing file...' : 'Drop a file here'}
      </p>
      <p className="text-xs text-muted">or</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        Choose file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".kml,.kmz,.geojson,.json,.zip,.gdb,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function FieldChips({ fields }: { fields: FeatureField[] }) {
  if (fields.length === 0) {
    return <p className="mt-1 text-sm text-muted">No attributes detected.</p>;
  }
  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {fields.map((f) => (
        <li
          key={f.name}
          className="inline-flex items-baseline gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
        >
          <span className="font-medium">{f.name}</span>
          <span className="text-[10px] text-muted">{f.type}</span>
        </li>
      ))}
    </ul>
  );
}

function TabBtn({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof Upload;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-accent text-ink-0'
          : 'border-transparent text-muted hover:text-ink-1'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function deriveFields(
  features: Array<{ properties?: Record<string, unknown> }>,
  cap: number,
): FeatureField[] {
  const fieldMap = new Map<string, FeatureField>();
  for (const f of features.slice(0, cap)) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (fieldMap.has(k)) continue;
      const type: FeatureField['type'] =
        typeof v === 'number'
          ? 'number'
          : typeof v === 'boolean'
            ? 'boolean'
            : 'string';
      fieldMap.set(k, { name: k, type, label: k, nullable: true });
    }
  }
  return [...fieldMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatLabel(format: SpatialFormat): string {
  switch (format) {
    case 'geojson':
      return 'GeoJSON';
    case 'kml':
      return 'KML';
    case 'kmz':
      return 'KMZ';
    case 'shapefile-zip':
      return 'Shapefile';
    case 'fgdb':
      return 'File Geodatabase';
    default:
      return 'Unknown';
  }
}
