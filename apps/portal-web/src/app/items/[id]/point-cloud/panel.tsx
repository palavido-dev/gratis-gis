// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Mountain,
  Sun,
  Upload as UploadIcon,
} from 'lucide-react';
import type { PointCloudData } from '@gratis-gis/shared-types';
import { isPointCloudData } from '@gratis-gis/shared-types';

// The 3D viewer carries the deck.gl + copc.js + laz-perf + proj4
// tree (via maplibre-gl-lidar), so it loads as its own chunk only
// when a point-cloud detail page actually renders a file, and
// never server-side (WebGL + wasm need a browser).
const PointCloudViewer = dynamic(() => import('./viewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[480px] w-full items-center justify-center rounded-md border border-border bg-surface-0">
      <Loader2 className="h-5 w-5 animate-spin text-muted" />
    </div>
  ),
});

/**
 * Detail-page panel for point_cloud items (#179, unit 1). Mirrors
 * the tile-layer editor's three states: empty (upload affordance),
 * uploading (progress bar), uploaded (metadata card + copyable
 * streaming URL). The finalize step validates the bytes server-
 * side against the COPC spec, so a plain LAS/LAZ upload comes
 * back with a conversion hint rather than a broken item.
 *
 * The in-browser 3D preview is unit 2 (it carries the deck.gl
 * dependency tree and must stay a lazy chunk); this panel keeps
 * the item usable before that lands: upload, verify, share, copy
 * the URL into any external COPC viewer.
 */
interface Props {
  itemId: string;
  initial: PointCloudData;
  canEdit: boolean;
}

export function PointCloudPanel({ itemId, initial, canEdit }: Props) {
  const [data, setData] = useState<PointCloudData>(initial);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [finalizing, setFinalizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = '';
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.laz') && !lower.endsWith('.las')) {
      setUploadError(
        'Point cloud items accept COPC files (.copc.laz). Convert other lidar formats with: pdal translate input.las output.copc.laz',
      );
      return;
    }
    void runUpload(file);
  }

  async function runUpload(file: File) {
    setUploadError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      // 1) Presigned PUT.
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'item-point-cloud',
          contentType: 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        setUploadError(await errorMessage(presignRes, 'Presign failed'));
        return;
      }
      const presign = (await presignRes.json()) as {
        uploadUrl: string;
        publicUrl: string;
        key: string;
        maxBytes: number;
      };
      if (file.size > presign.maxBytes) {
        setUploadError(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB but the per-file limit is ${(presign.maxBytes / 1024 / 1024 / 1024).toFixed(1)} GB.`,
        );
        return;
      }

      // 2) PUT bytes straight to storage; XHR for upload progress.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.open('PUT', presign.uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
      });

      // 3) Finalize: server validates the COPC header from the
      // uploaded bytes and lifts the metadata.
      setUploadProgress(100);
      setFinalizing(true);
      const finalizeRes = await fetch(
        `/api/portal/items/${itemId}/point-cloud/finalize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            storageKey: presign.key,
            storageUrl: presign.publicUrl,
            fileName: file.name,
            sizeBytes: file.size,
          }),
        },
      );
      if (!finalizeRes.ok) {
        setUploadError(await errorMessage(finalizeRes, 'Finalize failed'));
        return;
      }
      const body = (await finalizeRes.json()) as { data: PointCloudData };
      setData(body.data);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      setFinalizing(false);
      setUploadProgress(0);
    }
  }

  async function copyDataUrl() {
    if (!data.dataUrl) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${data.dataUrl}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard not allowed; the input field is still selectable */
    }
  }

  const ready = isPointCloudData(data) && data.storageKey.length > 0;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-3">
          <Mountain className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink-0">Point cloud file</h2>
        </div>
        <div className="space-y-4 p-4">
          {!ready && !uploading ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm text-ink-1">
                Upload a COPC point cloud (.copc.laz).
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                COPC is cloud-optimized lidar: viewers stream only the
                points in view instead of downloading the whole file.
                Convert plain LAS/LAZ with{' '}
                <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-2xs">
                  pdal translate input.las output.copc.laz
                </code>
              </p>
              {canEdit ? (
                <button
                  type="button"
                  onClick={pickFile}
                  className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  <UploadIcon className="h-4 w-4" />
                  Choose file
                </button>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  No file uploaded yet.
                </p>
              )}
            </div>
          ) : null}

          {uploading ? (
            <div className="rounded-md border border-border bg-surface-0 px-4 py-4">
              <p className="flex items-center gap-2 text-sm text-ink-0">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                {finalizing
                  ? 'Verifying the COPC header...'
                  : `Uploading... ${uploadProgress}%`}
              </p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          ) : null}

          {uploadError ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {uploadError}
            </div>
          ) : null}

          {ready ? (
            <>
              {data.dataUrl ? <PointCloudViewer data={data} /> : null}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <MetaItem label="File" value={data.fileName} mono />
                <MetaItem label="Size" value={formatBytes(data.sizeBytes)} />
                <MetaItem
                  label="Points"
                  value={
                    typeof data.pointCount === 'number'
                      ? data.pointCount.toLocaleString()
                      : 'Unknown'
                  }
                />
                <MetaItem
                  label="Format"
                  value={`COPC (LAS ${data.lasVersion ?? '1.4'}, point format ${data.pointFormat ?? '?'})`}
                />
                <MetaItem
                  label="Colors"
                  value={data.hasRgb ? 'RGB embedded' : 'No RGB (elevation coloring)'}
                />
                <MetaItem
                  label="Elevation range"
                  value={
                    data.bounds
                      ? `${round1(data.bounds[2])} to ${round1(data.bounds[5])}`
                      : 'Unknown'
                  }
                />
              </dl>
              {data.crsWkt ? (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer select-none hover:text-ink-1">
                    Coordinate system
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-2xs">
                    {data.crsWkt}
                  </pre>
                </details>
              ) : null}

              {data.dataUrl ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted">
                    Streaming URL (paste into any COPC viewer)
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={data.dataUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded-md border border-border bg-surface-0 px-2 py-1.5 font-mono text-xs text-ink-1"
                    />
                    <button
                      type="button"
                      onClick={() => void copyDataUrl()}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface-2 hover:text-ink-1"
                      aria-label="Copy streaming URL"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-success" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}

              {canEdit ? (
                <button
                  type="button"
                  onClick={pickFile}
                  disabled={uploading}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:border-accent hover:bg-accent/5 disabled:opacity-50"
                >
                  <UploadIcon className="h-3.5 w-3.5" />
                  Replace file
                </button>
              ) : null}
            </>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept=".laz,.las"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
      </section>

      {ready && canEdit ? (
        <HillshadeSection itemId={itemId} />
      ) : null}
    </div>
  );
}

interface AnalysisJobRow {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  error: string | null;
  targetItemId: string | null;
  createdAt: string;
}

/**
 * First workbench primitive chain (#184): derive a hillshade
 * raster server-side. The job list polls while anything is queued
 * or running; a finished job links to the created tile layer,
 * which the pyramid pipeline is meanwhile baking into PMTiles.
 * A 503 from the create endpoint means the operator has not
 * deployed the analysis worker; the message is surfaced verbatim.
 */
function HillshadeSection({ itemId }: { itemId: string }) {
  const [mode, setMode] = useState<'dtm' | 'dsm'>('dtm');
  const [resolution, setResolution] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AnalysisJobRow[]>([]);

  const active = jobs.some(
    (j) => j.state === 'queued' || j.state === 'running',
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/portal/items/${itemId}/analysis/jobs`);
        if (!res.ok) return;
        const rows = (await res.json()) as AnalysisJobRow[];
        if (!cancelled) setJobs(rows);
      } catch {
        /* transient; next poll retries */
      }
    }
    void load();
    // Poll faster while a job is in flight so progress feels live.
    const id = window.setInterval(() => void load(), active ? 4000 : 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [itemId, active]);

  async function submitTo(path: string, payload: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/analysis/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as {
        message?: string;
        job?: AnalysisJobRow;
      };
      if (!res.ok) {
        setError(body.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      if (body.job) setJobs((prev) => [body.job!, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    return submitTo('hillshade', { mode, resolution: Number(resolution) });
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-3">
        <Sun className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-medium text-ink-0">Derive hillshade</h2>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted">
          Builds an elevation model from the points on the server and
          shades it into a map-ready raster layer. Terrain uses ground
          returns only; surface includes vegetation and structures.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-2xs uppercase tracking-wide text-muted">
              Elevation model
            </span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'dtm' | 'dsm')}
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-xs text-ink-0"
            >
              <option value="dtm">Terrain (bare earth)</option>
              <option value="dsm">Surface (with canopy)</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-2xs uppercase tracking-wide text-muted">
              Resolution
            </span>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-xs text-ink-0"
            >
              <option value="1">1 meter</option>
              <option value="2">2 meters</option>
              <option value="5">5 meters</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || active}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sun className="h-3.5 w-3.5" />
            )}
            Run
          </button>
        </div>
        <div className="border-t border-border pt-3">
          <p className="text-xs leading-relaxed text-muted">
            You can also save the ground surface itself as an elevation
            layer. Maps can use it to show everything in 3D: the
            basemap, imagery, and boundary lines all follow the real
            hills and valleys.
          </p>
          <button
            type="button"
            onClick={() =>
              void submitTo('elevation', { resolution: Number(resolution) })
            }
            disabled={submitting || active}
            className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Mountain className="h-3.5 w-3.5" />
            )}
            Create elevation layer (for 3D)
          </button>
        </div>
        {error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}
        {jobs.length > 0 ? (
          <ul className="space-y-1.5">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-2 text-xs"
              >
                {j.state === 'running' || j.state === 'queued' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                ) : j.state === 'done' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <span className="text-danger">!</span>
                )}
                <span className="text-ink-1">
                  {j.kind === 'elevation' ? 'Elevation: ' : 'Hillshade: '}
                  {j.state === 'queued'
                    ? 'Waiting to start...'
                    : j.state === 'running'
                      ? `Working... ${j.progress}%`
                      : j.state === 'done'
                        ? 'Done'
                        : (j.error ?? 'Failed')}
                </span>
                {j.state === 'done' && j.targetItemId ? (
                  <Link
                    href={`/items/${j.targetItemId}`}
                    className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    Open result
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function MetaItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`text-ink-0 ${mono ? 'break-all font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  let msg = `${fallback} (HTTP ${res.status}).`;
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') msg = body.message;
  } catch {
    /* keep fallback */
  }
  return msg;
}
