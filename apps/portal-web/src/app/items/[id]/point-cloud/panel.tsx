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
  Leaf,
  Mountain,
  Sun,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import type {
  MergeCostCoefficients,
  PointCloudData,
} from '@gratis-gis/shared-types';
import {
  estimateMergeSeconds,
  formatRoughDuration,
  isPointCloudData,
} from '@gratis-gis/shared-types';

import {
  fileKey,
  uploadBatch,
  UploadError,
} from '@/lib/batch-upload';

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

/** What a finished tile upload knows about itself. */
interface SourceDescriptor {
  storageKey: string;
  publicUrl: string;
  fileName: string;
  sizeBytes: number;
}

export function PointCloudPanel({ itemId, initial, canEdit }: Props) {
  const [data, setData] = useState<PointCloudData>(initial);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'submitting'>(
    'idle',
  );
  const [progressLabel, setProgressLabel] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [copied, setCopied] = useState(false);
  // #205: "roughly 2.5 hours" from the build response, shown while
  // the merge runs so a long build is a known wait, not a mystery.
  const [buildEta, setBuildEta] = useState<string | null>(null);
  // #202: a batch with failed tiles waits here so the user can retry
  // just the failures, or start the merge with what made it.
  const [pendingRetry, setPendingRetry] = useState<{
    files: File[];
    endpoint: 'build' | 'add-sources';
    uploadedCount: number;
  } | null>(null);

  // Separate pickers for "new / replace" and "add tiles" so each
  // change handler knows the user's intent without guessing.
  const newInputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  // Descriptors of tiles uploaded THIS SESSION, keyed by fileKey, so
  // a retry after a partial failure re-sends only what is missing
  // (#202). Cleared when a merge actually starts.
  const uploadedRef = useRef<Map<string, SourceDescriptor>>(new Map());
  // Live per-file byte counts for the aggregate progress bar.
  const bytesRef = useRef<Map<string, number>>(new Map());
  // The merge cost model, fetched once per mount (#205).
  const limitsRef = useRef<MergeCostCoefficients | null>(null);

  const building = data.processingState === 'building';
  const buildFailed = data.processingState === 'failed';
  const hasFile = isPointCloudData(data) && data.storageKey.length > 0;
  const ready = hasFile && !building;
  const busy = phase !== 'idle';
  const sourceCount = data.sources?.length ?? 0;

  // While the worker merges tiles (#200), poll the item so the panel
  // flips to ready (or failed) on its own without a manual refresh.
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/portal/items/${itemId}`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          data?: unknown;
          item?: { data?: unknown };
        };
        const d = body.item?.data ?? body.data;
        if (!cancelled && isPointCloudData(d)) setData(d);
      } catch {
        /* transient; the next tick retries */
      }
    }
    const id = window.setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [building, itemId]);

  /** Presign + PUT one file. Throws UploadError on failure; the
   *  retryable flag separates a transient blip (5xx, 429, network)
   *  from something a retry can never fix (too large, 4xx). */
  async function uploadOne(
    file: File,
    onBytes?: (loaded: number) => void,
  ): Promise<SourceDescriptor> {
    const presignRes = await fetch('/api/portal/storage/presign-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'item-point-cloud',
        contentType: 'application/octet-stream',
      }),
    });
    if (!presignRes.ok) {
      throw new UploadError(
        await errorMessage(presignRes, 'Could not start upload'),
        presignRes.status >= 500 || presignRes.status === 429,
      );
    }
    const presign = (await presignRes.json()) as {
      uploadUrl: string;
      publicUrl: string;
      key: string;
      maxBytes: number;
    };
    if (file.size > presign.maxBytes) {
      throw new UploadError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB but the per-file limit is ${(presign.maxBytes / 1024 / 1024 / 1024).toFixed(1)} GB.`,
        false,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onBytes?.(e.loaded);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else
          reject(
            new UploadError(
              `Upload failed (HTTP ${xhr.status})`,
              xhr.status >= 500 || xhr.status === 429 || xhr.status === 0,
            ),
          );
      };
      xhr.onerror = () =>
        reject(new UploadError('Upload network error', true));
      xhr.open('PUT', presign.uploadUrl);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
    });
    return {
      storageKey: presign.key,
      publicUrl: presign.publicUrl,
      fileName: file.name,
      sizeBytes: file.size,
    };
  }

  function lidarNamesOk(files: File[]): boolean {
    for (const f of files) {
      const l = f.name.toLowerCase();
      if (!l.endsWith('.laz') && !l.endsWith('.las')) {
        setError(
          'Point clouds accept lidar files (.laz, .las, or .copc.laz).',
        );
        return false;
      }
    }
    return true;
  }

  async function refresh() {
    try {
      const res = await fetch(`/api/portal/items/${itemId}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: unknown;
        item?: { data?: unknown };
      };
      const d = body.item?.data ?? body.data;
      if (isPointCloudData(d)) setData(d);
    } catch {
      /* the building poll will pick up the state shortly */
    }
  }

  /** Empty-state / replace picker: one ready COPC takes the fast
   *  finalize path; several tiles (or a plain LAS that needs
   *  building) go through the merge. */
  async function onPickNew(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    if (files.length === 0) return;
    setError(null);
    if (!lidarNamesOk(files)) return;
    if (
      files.length === 1 &&
      files[0]!.name.toLowerCase().endsWith('.copc.laz')
    ) {
      await runFinalize(files[0]!);
    } else {
      await runBuild(files, 'build');
    }
  }

  async function onPickAdd(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    if (files.length === 0) return;
    setError(null);
    if (!lidarNamesOk(files)) return;
    await runBuild(files, 'add-sources');
  }

  /** Single ready COPC: upload + finalize (no worker). */
  async function runFinalize(file: File) {
    setPhase('uploading');
    setProgressPct(0);
    setProgressLabel('Uploading');
    try {
      const up = await uploadOne(file, (loaded) =>
        setProgressPct(Math.round((loaded / file.size) * 100)),
      );
      setPhase('submitting');
      setProgressLabel('Checking the file');
      const res = await fetch(
        `/api/portal/items/${itemId}/point-cloud/finalize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            storageKey: up.storageKey,
            storageUrl: up.publicUrl,
            fileName: up.fileName,
            sizeBytes: up.sizeBytes,
          }),
        },
      );
      if (!res.ok) {
        setError(await errorMessage(res, 'Could not finalize the upload'));
        return;
      }
      const body = (await res.json()) as { data: PointCloudData };
      setData(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setPhase('idle');
      setProgressPct(0);
    }
  }

  /** The merge cost model, fetched lazily and kept for the mount.
   *  Absence is not fatal: the server still enforces at build time,
   *  this only loses the pre-upload courtesy check. */
  async function mergeLimits(): Promise<MergeCostCoefficients | null> {
    if (limitsRef.current) return limitsRef.current;
    try {
      const res = await fetch('/api/portal/point-cloud/merge-limits');
      if (!res.ok) return null;
      limitsRef.current = (await res.json()) as MergeCostCoefficients;
      return limitsRef.current;
    } catch {
      return null;
    }
  }

  /** Bytes + tile count the WORKER will chew for this request. For
   *  add-sources that includes the tiles already on the item (the
   *  rebuild re-merges the full set), plus the original single file
   *  when it is the implicit first source. */
  function mergeWorkload(files: File[], endpoint: 'build' | 'add-sources') {
    let bytes = files.reduce((n, f) => n + f.size, 0);
    let tiles = files.length;
    if (endpoint === 'add-sources') {
      const existing = data.sources ?? [];
      bytes += existing.reduce((n, s) => n + (s.sizeBytes || 0), 0);
      tiles += existing.length;
      if (existing.length === 0 && data.storageKey) {
        bytes += data.sizeBytes || 0;
        tiles += 1;
      }
    }
    return { bytes, tiles };
  }

  function submitError(err: unknown): void {
    setError(err instanceof Error ? err.message : 'Upload failed.');
  }

  /** POST the merge request and adopt the response. */
  async function startMerge(
    sources: SourceDescriptor[],
    endpoint: 'build' | 'add-sources',
  ): Promise<void> {
    setPhase('submitting');
    setProgressLabel(
      endpoint === 'add-sources' ? 'Starting rebuild' : 'Starting merge',
    );
    const res = await fetch(
      `/api/portal/items/${itemId}/point-cloud/${endpoint}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map((s) => ({
            storageKey: s.storageKey,
            fileName: s.fileName,
            sizeBytes: s.sizeBytes,
          })),
        }),
      },
    );
    if (!res.ok) {
      setError(await errorMessage(res, 'Could not start the merge'));
      return;
    }
    const body = (await res.json()) as { humanEstimate?: string };
    setBuildEta(body.humanEstimate ?? null);
    // The batch is consumed; a future picker selection is a new one.
    uploadedRef.current.clear();
    setPendingRetry(null);
    // The server flipped the item to 'building'; pick that up so the
    // poll effect starts and the UI shows progress.
    await refresh();
  }

  /** Several tiles (or add-more): upload the batch resiliently
   *  (#202), then kick off the server merge. Re-entrant on purpose:
   *  "Retry failed tiles" calls this again with the same list and
   *  the session's uploadedRef skips everything already done. */
  async function runBuild(files: File[], endpoint: 'build' | 'add-sources') {
    setPhase('uploading');
    setProgressPct(0);
    setPendingRetry(null);
    try {
      // #205: the courtesy estimate BEFORE gigabytes move. The same
      // math the server enforces with, via the same shared function.
      const limits = await mergeLimits();
      const { bytes, tiles } = mergeWorkload(files, endpoint);
      const gb = (bytes / 1024 ** 3).toFixed(1);
      let etaNote = '';
      if (limits) {
        const sec = estimateMergeSeconds(bytes, tiles, limits);
        if (sec > limits.ceilingSec) {
          setError(
            `This area is very large: ${tiles} tiles, ${gb} GB. Merging it ` +
              `would take ${formatRoughDuration(sec)}, beyond what this ` +
              'server allows in one job. Split the upload into smaller ' +
              'areas and merge them separately.',
          );
          return;
        }
        etaNote = ` Build after upload: ${formatRoughDuration(sec)}.`;
      }

      bytesRef.current = new Map();
      const totalNew = files
        .filter((f) => !uploadedRef.current.has(fileKey(f)))
        .reduce((n, f) => n + f.size, 0);
      const label =
        files.length === 1
          ? `Uploading ${files[0]!.name}`
          : `Uploading ${files.length} tiles (${gb} GB).${etaNote}`;
      setProgressLabel(label);

      const repaint = () => {
        if (totalNew === 0) return setProgressPct(100);
        let loaded = 0;
        for (const v of bytesRef.current.values()) loaded += v;
        setProgressPct(
          Math.min(100, Math.round((loaded / totalNew) * 100)),
        );
      };

      const outcome = await uploadBatch(files, {
        uploadOne: (file) =>
          uploadOne(file, (loaded) => {
            bytesRef.current.set(fileKey(file), loaded);
            repaint();
          }),
        alreadyDone: uploadedRef.current,
        concurrency: 3,
        retries: 3,
        onFileDone: (done, total) => {
          if (total > 1) {
            setProgressLabel(
              `Uploaded ${done} of ${total} tiles (${gb} GB total).${etaNote}`,
            );
          }
        },
      });
      for (const s of outcome.succeeded) {
        uploadedRef.current.set(fileKey(s.file), s.descriptor);
        bytesRef.current.set(fileKey(s.file), s.file.size);
      }
      repaint();

      if (outcome.failed.length > 0) {
        const names = outcome.failed
          .slice(0, 3)
          .map((f) => f.file.name)
          .join(', ');
        const more =
          outcome.failed.length > 3
            ? ` and ${outcome.failed.length - 3} more`
            : '';
        setError(
          `${outcome.failed.length} of ${files.length} tiles did not upload ` +
            `(${names}${more}). Last error: ${outcome.failed[outcome.failed.length - 1]!.error} ` +
            `The ${outcome.succeeded.length} uploaded ${outcome.succeeded.length === 1 ? 'tile is' : 'tiles are'} kept for this session.`,
        );
        setPendingRetry({
          files,
          endpoint,
          uploadedCount: outcome.succeeded.length,
        });
        return;
      }

      // Order the sources by the picked file order, not completion
      // order: tile numbering in fileName is meaningful to people
      // reading the source list later.
      const sources = files
        .map((f) => uploadedRef.current.get(fileKey(f)))
        .filter((s): s is SourceDescriptor => s !== undefined);
      await startMerge(sources, endpoint);
    } catch (err) {
      submitError(err);
    } finally {
      setPhase('idle');
      setProgressPct(0);
    }
  }

  /** "Start the merge with what made it": the escape hatch after a
   *  partial upload. Add-tiles-later can top up the missing ones. */
  async function buildWithUploaded() {
    if (!pendingRetry) return;
    const sources = pendingRetry.files
      .map((f) => uploadedRef.current.get(fileKey(f)))
      .filter((s): s is SourceDescriptor => s !== undefined);
    if (sources.length === 0) return;
    setError(null);
    setPhase('submitting');
    try {
      await startMerge(sources, pendingRetry.endpoint);
    } catch (err) {
      submitError(err);
    } finally {
      setPhase('idle');
      setProgressPct(0);
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

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-3">
          <Mountain className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-sm font-medium text-ink-0">Point cloud file</h2>
        </div>
        <div className="space-y-4 p-4">
          {!hasFile && !building && !busy ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm text-ink-1">
                Add lidar and build a point cloud.
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                Pick one file or select several tiles at once. Multiple
                tiles are stitched into a single point cloud on the
                server, and you can add more tiles to it later. Accepts
                .copc.laz, .laz, and .las.
              </p>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => newInputRef.current?.click()}
                  className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  <UploadIcon className="h-4 w-4" />
                  Choose lidar files
                </button>
              ) : (
                <p className="mt-3 text-xs text-muted">No file uploaded yet.</p>
              )}
            </div>
          ) : null}

          {busy ? (
            <div className="rounded-md border border-border bg-surface-0 px-4 py-4">
              <p className="flex items-center gap-2 text-sm text-ink-0">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                {phase === 'submitting'
                  ? progressLabel
                  : `${progressLabel}... ${progressPct}%`}
              </p>
              {phase === 'uploading' ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {building && !busy ? (
            <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5 text-sm text-ink-1">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span>
                {sourceCount > 0
                  ? `Merging ${sourceCount} ${sourceCount === 1 ? 'tile' : 'tiles'} into one point cloud...`
                  : 'Building your point cloud...'}
                {buildEta ? ` Estimated: ${buildEta}.` : ''}
                {hasFile ? ' The current version stays available until it finishes.' : ''}
              </span>
            </div>
          ) : null}

          {buildFailed && !busy ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {data.processingError ??
                'The tiles could not be merged.'}{' '}
              {canEdit
                ? 'Your uploaded tiles were kept. Add them again or try different files.'
                : ''}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {error}
              {pendingRetry && !busy ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      void runBuild(pendingRetry.files, pendingRetry.endpoint);
                    }}
                    className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90"
                  >
                    Retry the failed tiles
                  </button>
                  {pendingRetry.uploadedCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => void buildWithUploaded()}
                      className="rounded-md border border-border bg-surface-1 px-3 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
                    >
                      {`Start the merge with the ${pendingRetry.uploadedCount} uploaded`}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {hasFile ? (
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
                  value={
                    data.hasRgb ? 'RGB embedded' : 'No RGB (elevation coloring)'
                  }
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

              {sourceCount > 0 ? (
                <p className="text-xs text-muted">
                  Built by merging{' '}
                  <span className="font-medium text-ink-1">
                    {sourceCount}
                  </span>{' '}
                  {sourceCount === 1 ? 'tile' : 'tiles'}.
                </p>
              ) : null}

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
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => addInputRef.current?.click()}
                    disabled={busy || building}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:border-accent hover:bg-accent/5 disabled:opacity-50"
                  >
                    <UploadIcon className="h-3.5 w-3.5" />
                    Add more tiles
                  </button>
                  <button
                    type="button"
                    onClick={() => newInputRef.current?.click()}
                    disabled={busy || building}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:border-accent hover:bg-accent/5 disabled:opacity-50"
                  >
                    <UploadIcon className="h-3.5 w-3.5" />
                    Replace
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          <input
            ref={newInputRef}
            type="file"
            accept=".laz,.las"
            multiple
            className="hidden"
            onChange={onPickNew}
          />
          <input
            ref={addInputRef}
            type="file"
            accept=".laz,.las"
            multiple
            className="hidden"
            onChange={onPickAdd}
          />
        </div>
      </section>

      {ready && canEdit ? <HillshadeSection itemId={itemId} /> : null}
    </div>
  );
}

interface AnalysisJobRow {
  id: string;
  kind: string;
  // Full lifecycle from the AnalysisJob model: ingest/importing are
  // the contours bridge states (rare on this panel but the API can
  // return them), cancel_requested is the stopping window between a
  // cancel click and the worker confirming.
  state:
    | 'queued'
    | 'running'
    | 'ingest'
    | 'importing'
    | 'cancel_requested'
    | 'done'
    | 'failed'
    | 'cancelled';
  progress: number;
  error: string | null;
  targetItemId: string | null;
  createdAt: string;
}

/** States where the job is still moving and worth fast polling. */
function isActiveJobState(state: AnalysisJobRow['state']): boolean {
  return (
    state === 'queued' ||
    state === 'running' ||
    state === 'ingest' ||
    state === 'importing' ||
    state === 'cancel_requested'
  );
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
  // Guards double-fire on the row's Cancel button; the button also
  // disappears optimistically, but a slow response should not queue
  // a second POST.
  const cancelInFlightRef = useRef<Set<string>>(new Set());

  const active = jobs.some((j) => isActiveJobState(j.state));

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

  async function cancelJob(job: AnalysisJobRow) {
    if (cancelInFlightRef.current.has(job.id)) return;
    cancelInFlightRef.current.add(job.id);
    try {
      await fetch(`/api/portal/analysis-jobs/${job.id}/cancel`, {
        method: 'POST',
      });
      // Optimistic flip so the row reacts before the next poll:
      // queued dies immediately server-side; running enters the
      // stopping window until the worker confirms.
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id && isActiveJobState(j.state)
            ? {
                ...j,
                state: j.state === 'queued' ? 'cancelled' : 'cancel_requested',
              }
            : j,
        ),
      );
    } catch {
      /* transient; the next poll reconciles */
    } finally {
      cancelInFlightRef.current.delete(job.id);
    }
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
        <div className="border-t border-border pt-3">
          <p className="text-xs leading-relaxed text-muted">
            Or measure how tall everything is: the height of trees,
            buildings, and anything else above the bare ground, as a
            colored layer for maps.
          </p>
          <button
            type="button"
            onClick={() =>
              void submitTo('heightmap', { resolution: Number(resolution) })
            }
            disabled={submitting || active}
            className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium text-ink-0 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Leaf className="h-3.5 w-3.5" />
            )}
            Create height-above-ground map
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
                {isActiveJobState(j.state) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                ) : j.state === 'done' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : j.state === 'cancelled' ? (
                  // Deliberately muted, not danger-red: a cancel is
                  // the user's own decision, not something broken.
                  <X className="h-3.5 w-3.5 text-muted" />
                ) : (
                  <span className="text-danger">!</span>
                )}
                <span
                  className={
                    j.state === 'cancelled' ? 'text-muted' : 'text-ink-1'
                  }
                >
                  {j.kind === 'elevation'
                    ? 'Elevation: '
                    : j.kind === 'heightmap'
                      ? 'Height above ground: '
                      : 'Hillshade: '}
                  {j.state === 'queued'
                    ? 'Waiting to start...'
                    : j.state === 'cancel_requested'
                      ? 'Stopping...'
                      : j.state === 'cancelled'
                        ? 'Cancelled'
                        : isActiveJobState(j.state)
                          ? `Working... ${j.progress}%`
                          : j.state === 'done'
                            ? 'Done'
                            : (j.error ?? 'Failed')}
                </span>
                {j.state === 'queued' || j.state === 'running' ? (
                  <button
                    type="button"
                    onClick={() => void cancelJob(j)}
                    className="ml-auto shrink-0 rounded border border-border bg-surface-0 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
                  >
                    Cancel
                  </button>
                ) : null}
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
