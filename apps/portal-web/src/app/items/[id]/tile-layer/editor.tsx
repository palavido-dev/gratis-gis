// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { ensureRasterProtocols } from '@/lib/custom-basemap';
import {
  Check,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  Upload as UploadIcon,
} from 'lucide-react';
import type {
  MergeCostCoefficients,
  TileLayerData,
  TileLayerOriginalFormat,
} from '@gratis-gis/shared-types';
import {
  estimateMergeSeconds,
  formatRoughDuration,
  isTileLayerData,
} from '@gratis-gis/shared-types';
import { formatBytes } from '@/lib/format-bytes';
import { UploadError, fileKey, uploadBatch } from '@/lib/batch-upload';
import { DemAnalysisSection } from './dem-analysis';

/** What one presigned-PUT source upload produces (#199); the shape
 *  mosaic-build / mosaic-add-sources take per source. */
interface SourceDescriptor {
  storageKey: string;
  fileName: string;
  sizeBytes: number;
}

/** Raster-only extensions eligible for mosaicking. Pre-tiled
 *  packages (.pmtiles / .mbtiles / .zip) stay single-file: there
 *  is no raster to compose. */
function isMosaicSource(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.tif') ||
    lower.endsWith('.tiff') ||
    lower.endsWith('.geotiff') ||
    lower.endsWith('.cog') ||
    lower.endsWith('.jp2')
  );
}

/**
 * Detail-page editor for tile_layer items (#179). Three states:
 *
 *   1. No file uploaded yet: shows an upload affordance + the
 *      list of supported formats (PMTiles in v1).
 *   2. Upload in progress: shows the file name + a progress bar.
 *   3. File uploaded and metadata extracted: shows the metadata
 *      (file size, zoom range, bbox, tile type, attribution) +
 *      a map preview rendered through the pmtiles protocol +
 *      a copyable tile URL for use in basemaps.
 *
 * Replace-file: the existing item can have its bytes swapped by
 * uploading a new file. The old MinIO object is left in place;
 * we'd want a cleanup pass eventually but for v1 the orphan
 * accounting on the storage card surfaces it.
 *
 * Map preview uses MapLibre GL's pmtiles protocol plugin
 * (registered once per page load). For raster tile types we add a
 * raster source + layer; for vector (mvt) we add a vector source
 * and a thin debug fill layer so the user at least sees that
 * tiles are being served, even if they haven't authored a style
 * yet. A future iteration could probe the vector layers and
 * render a meaningful default style.
 */
interface Props {
  itemId: string;
  initial: TileLayerData;
  canEdit: boolean;
}

export function TileLayerEditor({ itemId, initial, canEdit }: Props) {
  const [data, setData] = useState<TileLayerData>(initial);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // #199 mosaic state: worker ETA for the running build, resumable
  // uploads (keyed by name|size|mtime), and the partial-failure
  // recovery offer. Mirrors the point-cloud panel.
  const [buildEta, setBuildEta] = useState<string | null>(null);
  const uploadedRef = useRef(new Map<string, SourceDescriptor>());
  const limitsRef = useRef<MergeCostCoefficients | null>(null);
  const [pendingRetry, setPendingRetry] = useState<{
    files: File[];
    endpoint: 'mosaic-build' | 'mosaic-add-sources';
    uploadedCount: number;
  } | null>(null);

  const building = data.processingState === 'building';
  const buildFailed = data.processingState === 'failed';

  // Poll the item while the pyramid build is in flight.  States
  // that should trigger refresh: 'cog-ready' (waiting for the
  // worker to pick it up), 'tiling' (job is running), and #199
  // 'building' (the mosaic worker is composing sources).
  // Terminal states ('pmtiles-ready', 'tiling-failed', 'failed')
  // don't trigger polling.  Polling stops when the component
  // unmounts OR when the state advances out of a transient value.
  const transientState =
    data.processingState === 'cog-ready' ||
    data.processingState === 'tiling' ||
    data.processingState === 'building';
  useEffect(() => {
    if (!transientState) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/portal/items/${itemId}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { item?: { data?: unknown } };
        if (cancelled) return;
        if (body.item?.data && isTileLayerData(body.item.data)) {
          const next = body.item.data;
          // Most ticks return a payload identical to what we already
          // hold, just as a fresh object.  Adopting that new identity
          // re-rendered everything keyed on `data`, most painfully the
          // TilePreview effect, which tears down and recreates its
          // whole MapLibre map, so the preview flashed every 5s for
          // the duration of a pyramid build.  Keep the old object when
          // the content is unchanged; stableStringify makes the
          // comparison independent of server key ordering.
          setData((prev) =>
            stableStringify(prev) === stableStringify(next) ? prev : next,
          );
        }
      } catch {
        /* network blips are fine; next tick will retry */
      }
    };
    // Poll every 5s while transient; the worker's own loop is
    // 10s so we'll sometimes refresh just after a state change.
    const id = window.setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [itemId, transientState]);

  async function retryPyramid() {
    setRetrying(true);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/tile-layer/retry-pyramid`,
        { method: 'POST', credentials: 'include' },
      );
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown };
        if (body.data && isTileLayerData(body.data)) {
          setData(body.data);
        }
      }
    } finally {
      setRetrying(false);
    }
  }

  // Register the pmtiles and cog protocols through the shared
  // helper.  Registration is global state on the maplibregl
  // singleton, idempotent, and must OUTLIVE this editor: an unmount
  // cleanup used to call removeProtocol here while the global
  // registration guards elsewhere (map-canvas, custom-basemap)
  // stayed set, so after visiting a tile-layer page every later map
  // surface in the same SPA session failed with "URL scheme not
  // supported" until a hard reload.  Leaving the schemes registered
  // matches every other map surface.
  useEffect(() => {
    ensureRasterProtocols();
  }, []);

  async function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(ev.target.files ?? []);
    // Reset the input so the same file can be selected twice (a
    // re-upload of the same name shouldn't be silently ignored).
    ev.target.value = '';
    if (files.length === 0) return;
    // #199: several files picked at once become one mosaic. One
    // file keeps the original single-upload path untouched.
    if (files.length > 1) {
      await runMosaic(files, 'mosaic-build');
      return;
    }
    const file = files[0]!;
    const lower = file.name.toLowerCase();
    // Supported: pre-tiled containers + raw raster inputs that
    // the api converts to COG at ingest (then a background
    // worker bakes a PMTiles pyramid).
    const supported =
      lower.endsWith('.pmtiles') ||
      lower.endsWith('.mbtiles') ||
      lower.endsWith('.zip') ||
      lower.endsWith('.tif') ||
      lower.endsWith('.tiff') ||
      lower.endsWith('.geotiff') ||
      lower.endsWith('.cog') ||
      lower.endsWith('.jp2');
    if (!supported) {
      if (lower.endsWith('.tpk') || lower.endsWith('.tpkx')) {
        setUploadError(
          'TPK / TPKX support is on the roadmap. For now: export your tile cache to MBTiles (or convert from TPK with the pmtiles CLI) and upload that. Supported today: .pmtiles, .mbtiles, .zip, .tif / .tiff / .geotiff, .cog, .jp2.',
        );
      } else if (lower.endsWith('.ecw') || lower.endsWith('.sid')) {
        setUploadError(
          `${lower.endsWith('.ecw') ? 'ECW' : 'MrSID'} ingest isn't supported (proprietary decoder license isn't AGPL-compatible). Convert to GeoTIFF locally with a GDAL build that includes the vendor SDK, then upload the .tif.`,
        );
      } else {
        setUploadError(
          'Supported formats: .pmtiles, .mbtiles, .zip (XYZ tile directory), .tif / .tiff / .geotiff, .cog, .jp2.',
        );
      }
      return;
    }
    // Pre-flight space check before bothering with the presigned
    // URL.  The api reports back whether the upload + COG
    // conversion + (eventual) PMTiles pyramid will fit on the
    // host's free disk.  Failing here saves megabytes of wasted
    // PUT traffic.
    setUploadError(null);
    try {
      const spaceRes = await fetch('/api/portal/tile-layer/check-space', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          sizeBytes: file.size,
        }),
      });
      if (spaceRes.ok) {
        const body = (await spaceRes.json()) as {
          ok: boolean;
          reason?: string;
        };
        if (!body.ok) {
          setUploadError(body.reason ?? 'Not enough free disk space.');
          return;
        }
      }
      // 4xx / 5xx: fail-open and let the real upload surface the
      // error.  The space check is best-effort.
    } catch {
      /* network / parse failure - fail-open, real upload will catch issues */
    }
    await runUpload(file);
  }

  async function runUpload(file: File) {
    setUploadError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      // 1) Ask the api for a presigned PUT.
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'item-tile-layer',
          contentType: 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        let msg = `Presign failed (HTTP ${presignRes.status}).`;
        try {
          const body = (await presignRes.json()) as { message?: unknown };
          if (typeof body.message === 'string') msg = body.message;
        } catch {
          /* keep fallback */
        }
        setUploadError(msg);
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

      // 2) PUT the bytes to MinIO, tracking progress through an
      // XHR (fetch doesn't expose upload progress). XHR is the
      // baseline; we'd switch to fetch+stream if the browser
      // matrix ever drops XHR.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed (HTTP ${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.open('PUT', presign.uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
      });

      // 3) Tell the api to finalize: read the PMTiles header
      // from the uploaded file, extract metadata, persist on the
      // item. This is where the slow header-parse happens; we
      // already showed 100% so the user sees that the bytes are
      // done and we're just reading the header.
      setUploadProgress(100);
      const finalizeRes = await fetch(
        `/api/portal/items/${itemId}/tile-layer/finalize`,
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
        let msg = `Finalize failed (HTTP ${finalizeRes.status}).`;
        try {
          const body = (await finalizeRes.json()) as { message?: unknown };
          if (typeof body.message === 'string') msg = body.message;
        } catch {
          /* keep fallback */
        }
        setUploadError(msg);
        return;
      }
      const body = (await finalizeRes.json()) as { data: TileLayerData };
      setData(body.data);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  // ---------------------- imagery mosaic (#199) ----------------------

  function onAddImages(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    if (files.length === 0) return;
    void runMosaic(files, 'mosaic-add-sources');
  }

  /** Deployment-wide cost coefficients, fetched once per mount.
   *  Failure is non-fatal: the server re-checks at enqueue. */
  async function mosaicLimits(): Promise<MergeCostCoefficients | null> {
    if (limitsRef.current) return limitsRef.current;
    try {
      const res = await fetch('/api/portal/tile-layer/mosaic-limits');
      if (!res.ok) return null;
      limitsRef.current = (await res.json()) as MergeCostCoefficients;
      return limitsRef.current;
    } catch {
      return null;
    }
  }

  /** Total bytes + image count the build will actually process:
   *  adding to an existing mosaic re-composes over the FULL set,
   *  and a single-file layer's original counts as one source. */
  function mosaicWorkload(
    files: File[],
    endpoint: 'mosaic-build' | 'mosaic-add-sources',
  ): { bytes: number; tiles: number } {
    let bytes = files.reduce((n, f) => n + f.size, 0);
    let tiles = files.length;
    if (endpoint === 'mosaic-add-sources') {
      const existing = data.sources ?? [];
      if (existing.length > 0) {
        bytes += existing.reduce((n, s) => n + s.sizeBytes, 0);
        tiles += existing.length;
      } else if (data.cogStorageKey || data.storageKey) {
        bytes += data.cogSizeBytes ?? data.sizeBytes ?? 0;
        tiles += 1;
      }
    }
    return { bytes, tiles };
  }

  /** One presigned PUT, mirroring the single-file path but with
   *  batch-friendly error semantics: terminal refusals are
   *  non-retryable UploadErrors, network blips retry. */
  async function mosaicUploadOne(file: File): Promise<SourceDescriptor> {
    const presignRes = await fetch('/api/portal/storage/presign-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'item-tile-layer',
        contentType: 'application/octet-stream',
      }),
    });
    if (!presignRes.ok) {
      throw new UploadError(
        `Could not start the upload (HTTP ${presignRes.status}).`,
        presignRes.status >= 500,
      );
    }
    const presign = (await presignRes.json()) as {
      uploadUrl: string;
      key: string;
      maxBytes: number;
    };
    if (file.size > presign.maxBytes) {
      throw new UploadError(
        `"${file.name}" is ${formatBytes(file.size)}, over the ` +
          `${formatBytes(presign.maxBytes)} per-file limit.`,
        false,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload network error'));
      xhr.open('PUT', presign.uploadUrl);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
    });
    return { storageKey: presign.key, fileName: file.name, sizeBytes: file.size };
  }

  /** Upload N images (resumable, continue-on-failure) and queue the
   *  mosaic build. Mirrors the point-cloud panel's runBuild. */
  async function runMosaic(
    files: File[],
    endpoint: 'mosaic-build' | 'mosaic-add-sources',
  ) {
    setUploadError(null);
    setPendingRetry(null);
    const bad = files.find((f) => !isMosaicSource(f.name));
    if (bad) {
      setUploadError(
        `"${bad.name}" can't join a mosaic. Combining works with plain ` +
          'imagery (.tif / .tiff / .geotiff / .cog / .jp2); tile packages ' +
          'upload one at a time.',
      );
      return;
    }
    // #205 rule: refuse an impossible build BEFORE uploading
    // gigabytes. The server enforces the same model at enqueue.
    const limits = await mosaicLimits();
    if (limits) {
      const { bytes, tiles } = mosaicWorkload(files, endpoint);
      const sec = estimateMergeSeconds(bytes, tiles, limits);
      if (sec > limits.ceilingSec) {
        setUploadError(
          `That is ${tiles} images totalling ${formatBytes(bytes)}. ` +
            `Building the mosaic would take ${formatRoughDuration(sec)}, ` +
            'beyond what this server allows in one job. Split it into ' +
            'smaller mosaics.',
        );
        return;
      }
    }
    setUploading(true);
    setProgressLabel(`Uploading ${files.length} images...`);
    try {
      const outcome = await uploadBatch(files, {
        uploadOne: mosaicUploadOne,
        alreadyDone: uploadedRef.current,
        concurrency: 3,
        retries: 3,
        onFileDone: (done, total) =>
          setProgressLabel(`Uploaded ${done} of ${total} images...`),
      });
      for (const s of outcome.succeeded) {
        uploadedRef.current.set(fileKey(s.file), s.descriptor);
      }
      if (outcome.failed.length > 0) {
        const names = outcome.failed
          .slice(0, 3)
          .map((f) => `"${f.file.name}"`)
          .join(', ');
        setUploadError(
          `${outcome.failed.length} of ${files.length} images did not ` +
            `upload (${names}${outcome.failed.length > 3 ? ', ...' : ''}). ` +
            outcome.failed[0]!.error,
        );
        setPendingRetry({
          files,
          endpoint,
          uploadedCount: outcome.succeeded.length,
        });
        return;
      }
      // Descriptors in picked-file order: where images overlap, the
      // LAST one wins in the composed mosaic.
      const sources = files
        .map((f) => uploadedRef.current.get(fileKey(f)))
        .filter((s): s is SourceDescriptor => Boolean(s));
      await startMosaic(sources, endpoint);
    } finally {
      setUploading(false);
      setProgressLabel(null);
    }
  }

  async function startMosaic(
    sources: SourceDescriptor[],
    endpoint: 'mosaic-build' | 'mosaic-add-sources',
  ) {
    const res = await fetch(
      `/api/portal/items/${itemId}/tile-layer/${endpoint}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources }),
      },
    );
    if (!res.ok) {
      let msg = `Could not start the mosaic build (HTTP ${res.status}).`;
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string') msg = body.message;
      } catch {
        /* keep fallback */
      }
      setUploadError(msg);
      return;
    }
    const body = (await res.json()) as { humanEstimate?: unknown };
    setBuildEta(
      typeof body.humanEstimate === 'string' ? body.humanEstimate : null,
    );
    uploadedRef.current.clear();
    setPendingRetry(null);
    await refreshItem();
  }

  /** Re-run the whole batch; already-uploaded files resume via the
   *  uploadedRef cache, so only the failures transfer again. */
  async function retryFailedUploads() {
    const p = pendingRetry;
    if (!p) return;
    await runMosaic(p.files, p.endpoint);
  }

  /** Start the build with just the images that made it. */
  async function buildWithUploaded() {
    const p = pendingRetry;
    if (!p) return;
    const sources = p.files
      .map((f) => uploadedRef.current.get(fileKey(f)))
      .filter((s): s is SourceDescriptor => Boolean(s));
    if (sources.length === 0) return;
    setUploadError(null);
    setPendingRetry(null);
    await startMosaic(sources, p.endpoint);
  }

  /** Failed-build retry over the retained sources; addedAt is
   *  preserved server-side for already-registered keys. */
  async function retryMosaicBuild() {
    const sources = (data.sources ?? []).map((s) => ({
      storageKey: s.storageKey,
      fileName: s.fileName,
      sizeBytes: s.sizeBytes,
    }));
    if (sources.length === 0) return;
    setRetrying(true);
    try {
      await startMosaic(sources, 'mosaic-build');
    } finally {
      setRetrying(false);
    }
  }

  async function refreshItem() {
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { item?: { data?: unknown } };
      if (body.item?.data && isTileLayerData(body.item.data)) {
        setData(body.item.data);
      }
    } catch {
      /* the poll will catch up */
    }
  }

  async function copyTileUrl() {
    if (!data.tileUrl) return;
    try {
      await navigator.clipboard.writeText(data.tileUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard not allowed; the input field is still selectable */
    }
  }

  const ready = isTileLayerData(data) && data.storageUrl.length > 0;

  return (
    <div className="space-y-4">
      {/* File / upload card */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Imagery or tile file</h3>
          <p className="mt-0.5 text-xs text-muted">
            Upload map imagery or a ready-made tile package.
            Accepted: <strong>.pmtiles</strong>,{' '}
            <strong>.mbtiles</strong>, a <strong>.zip</strong> of
            map tiles, or plain imagery as <strong>.tif</strong> /{' '}
            <strong>.tiff</strong> / <strong>.geotiff</strong>,{' '}
            <strong>.cog</strong>, <strong>.jp2</strong>.
            Pick several images at once and they become one
            seamless mosaic. Everything is prepared automatically
            so maps can display it quickly. TPK / TPKX, ECW, and
            MrSID aren&rsquo;t supported.
          </p>
        </div>
        <div className="space-y-3 p-4 text-sm">
          {ready ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline gap-2 text-ink-0">
                <span className="font-medium">{data.fileName}</span>
                <span className="text-xs text-muted">
                  {formatBytes(data.sizeBytes)}
                </span>
              </div>
              {(data.sources?.length ?? 0) > 0 ? (
                <p className="text-xs text-muted">
                  Built by combining {data.sources!.length} images.
                  The originals are kept, so more can be added.
                </p>
              ) : null}
              {data.name || data.description ? (
                <p className="text-xs text-muted">
                  {data.name ? <strong>{data.name}</strong> : null}
                  {data.name && data.description ? ' — ' : ''}
                  {data.description ?? null}
                </p>
              ) : null}
            </div>
          ) : building ? null : (
            <p className="text-xs text-muted">
              No tile file uploaded yet.
            </p>
          )}
          {/* #199: mosaic build lifecycle. Lives here rather than
              in the pyramid card because a FRESH mosaic has no
              served file yet (ready is false) and the pyramid card
              only exists after one. */}
          {building ? (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-ink-1">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-info" />
              <span className="text-info/80">
                <span className="font-medium text-info">
                  Combining {data.sources?.length ?? ''} images into
                  one mosaic...
                </span>{' '}
                {buildEta ? `Estimated: ${buildEta}. ` : ''}
                {ready
                  ? 'The current version stays available until it finishes.'
                  : 'This page updates by itself when it finishes.'}
              </span>
            </div>
          ) : null}
          {buildFailed ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink-1">
                <span className="font-medium text-warn">
                  The mosaic build failed.
                </span>
                <span className="text-warn/80">
                  {data.processingError ??
                    'Something went wrong while combining the images.'}{' '}
                  Your uploaded images were kept.
                </span>
              </div>
              {canEdit && (data.sources?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => void retryMosaicBuild()}
                  disabled={retrying || uploading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
                >
                  {retrying ? 'Starting...' : 'Try the build again'}
                </button>
              ) : null}
            </div>
          ) : null}
          {ready ? (
            /* Download for desktop GIS (QGIS, others): the same
               bytes maps stream, served as a named file. Raster
               items offer the GeoTIFF (the archival master, ideal
               for desktop use); pre-tiled uploads offer the tile
               package itself. */
            <div className="flex flex-wrap items-center gap-2">
              {data.cogStorageKey ? (
                <a
                  href={`/api/portal/tile-layer/${itemId}/file.cog?download=1`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
                >
                  <Download className="h-4 w-4" />
                  Download image (GeoTIFF)
                </a>
              ) : (
                <a
                  href={`/api/portal/tile-layer/${itemId}/file?download=1`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
                >
                  <Download className="h-4 w-4" />
                  Download file
                </a>
              )}
            </div>
          ) : null}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void pickFile()}
                disabled={uploading || building}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : ready ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <UploadIcon className="h-4 w-4" />
                )}
                {uploading
                  ? (progressLabel ?? `Uploading ${uploadProgress}%...`)
                  : ready
                    ? 'Replace file'
                    : 'Upload file'}
              </button>
              {/* #199: extend an existing raster layer with more
                  images. Hidden for vector packages (nothing to
                  compose) and elevation layers (terrain composes
                  per map through the elevation stack instead). */}
              {ready &&
              !data.dem &&
              data.kind !== 'vector' &&
              (data.cogStorageKey || (data.sources?.length ?? 0) > 0) ? (
                <button
                  type="button"
                  onClick={() => addInputRef.current?.click()}
                  disabled={uploading || building}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
                >
                  <UploadIcon className="h-4 w-4" />
                  Add more images
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pmtiles,.mbtiles,.zip,.tif,.tiff,.geotiff,.cog,.jp2"
                onChange={(e) => void onFileChange(e)}
                className="hidden"
              />
              <input
                ref={addInputRef}
                type="file"
                multiple
                accept=".tif,.tiff,.geotiff,.cog,.jp2"
                onChange={onAddImages}
                className="hidden"
              />
            </div>
          ) : null}
          {uploadError ? (
            <p className="text-xs text-danger" role="alert">
              {uploadError}
            </p>
          ) : null}
          {pendingRetry ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void retryFailedUploads()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
              >
                Retry the failed images
              </button>
              {pendingRetry.uploadedCount > 0 ? (
                <button
                  type="button"
                  onClick={() => void buildWithUploaded()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
                >
                  Start with the {pendingRetry.uploadedCount} uploaded
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* Pyramid build status (only present for raster-uploaded
          items that go through the COG -> PMTiles bridge).      */}
      {ready && data.processingState ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <div className="border-b border-border bg-surface-2 px-4 py-3">
            <h3 className="text-sm font-medium text-ink-0">
              Processing status
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              Your image works on maps right away. In the
              background we also prepare a faster version for
              smooth panning and zooming; maps switch to it
              automatically when it&rsquo;s ready.
            </p>
          </div>
          <div className="space-y-2 p-4 text-sm">
            {data.processingState === 'ready' ? (
              <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-ink-1">
                <span className="font-medium text-success">Ready.</span>
                <span className="text-success/80">
                  {data.dem
                    ? "This elevation layer is ready. Add it in the 3D terrain section of a map's layers panel to turn on 3D."
                    : 'This layer is ready to use on maps.'}
                </span>
              </div>
            ) : null}
            {data.processingState === 'cog-ready' ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-ink-1">
                <span className="font-medium">Waiting to start.</span>
                <span className="text-muted">
                  The speed-up will begin within a minute. Your
                  layer already works on maps in the meantime.
                </span>
              </div>
            ) : null}
            {data.processingState === 'tiling' ? (
              <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-ink-1">
                <span className="font-medium text-info">
                  Optimizing...
                </span>
                <span className="text-info/80">
                  This can take several minutes for large images.
                  Your layer already works on maps and will get
                  faster automatically when this finishes.
                  {data.tilingStartedAt
                    ? ` Started ${humanDate(data.tilingStartedAt)}.`
                    : ''}
                </span>
              </div>
            ) : null}
            {data.processingState === 'pmtiles-ready' ? (
              <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-ink-1">
                <span className="font-medium text-success">
                  Ready.
                </span>
                <span className="text-success/80">
                  This layer is optimized for fast map display
                  {data.tilingCompletedAt
                    ? ` (finished ${humanDate(data.tilingCompletedAt)})`
                    : ''}
                  . The original file is kept too (
                  {data.cogSizeBytes !== undefined
                    ? formatBytes(data.cogSizeBytes)
                    : 'size unknown'}
                  ).
                </span>
              </div>
            ) : null}
            {data.processingState === 'tiling-failed' ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink-1">
                  <span className="font-medium text-warn">
                    Speed-up failed.
                  </span>
                  <span className="text-warn/80">
                    Your layer still works on maps, just a little
                    slower. Try again, or contact your
                    administrator if it keeps failing.
                  </span>
                </div>
                {data.tilingError ? (
                  <pre className="overflow-x-auto rounded border border-border bg-surface-2 p-2 text-2xs text-muted">
                    {data.tilingError}
                  </pre>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => void retryPyramid()}
                    disabled={retrying}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
                  >
                    {retrying ? 'Retrying...' : 'Try again'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Terrain analysis: only elevation (dem) layers, once the
          file is in place. */}
      {ready && data.dem ? (
        <DemAnalysisSection itemId={itemId} canEdit={canEdit} />
      ) : null}

      {/* Metadata card */}
      {ready ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <div className="border-b border-border bg-surface-2 px-4 py-3">
            <h3 className="text-sm font-medium text-ink-0">File details</h3>
            <p className="mt-0.5 text-xs text-muted">
              Read from the file when it was uploaded. Re-upload to
              refresh.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 p-4 text-xs sm:grid-cols-2">
            <Metric
              label="Type"
              value={`${data.format === 'pmtiles' ? 'Tile package' : 'Web-ready image'} (${data.kind === 'vector' ? 'vector' : 'imagery'})`}
            />
            <Metric
              label="Tile type"
              value={data.tileType ? data.tileType.toUpperCase() : 'unknown'}
            />
            <Metric
              label="Zoom range"
              value={
                data.minZoom !== undefined && data.maxZoom !== undefined
                  ? `${data.minZoom} – ${data.maxZoom}`
                  : '(not listed in the file)'
              }
            />
            <Metric label="Size on disk" value={formatBytes(data.sizeBytes)} />
            {data.originalFormat && data.originalFormat !== 'pmtiles' ? (
              <Metric
                label="Original upload"
                value={`${originalFormatLabel(data.originalFormat)}${
                  data.originalFileName ? ` (${data.originalFileName})` : ''
                }${
                  typeof data.conversionMs === 'number'
                    ? ` · converted in ${(data.conversionMs / 1000).toFixed(1)}s`
                    : ''
                }`}
              />
            ) : null}
            <Metric
              label="Coverage (west, south, east, north)"
              value={
                data.bbox
                  ? `${data.bbox[0].toFixed(3)}, ${data.bbox[1].toFixed(3)}, ${data.bbox[2].toFixed(3)}, ${data.bbox[3].toFixed(3)}`
                  : '(not listed in the file)'
              }
            />
            <Metric
              label="Center"
              value={
                data.centerLng !== undefined && data.centerLat !== undefined
                  ? `${data.centerLng.toFixed(3)}, ${data.centerLat.toFixed(3)}${data.centerZoom !== undefined ? ` (z${data.centerZoom})` : ''}`
                  : '(not listed in the file)'
              }
            />
            {data.attribution ? (
              <div className="sm:col-span-2">
                <Metric label="Attribution" value={data.attribution} />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Tile URL + use-as-basemap card */}
      {ready && data.tileUrl ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <div className="border-b border-border bg-surface-2 px-4 py-3">
            <h3 className="text-sm font-medium text-ink-0">
              Use as basemap
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              To use this layer as a map background, copy this
              address and paste it into a Basemap item&rsquo;s
              source field.
            </p>
          </div>
          <div className="flex gap-2 p-4">
            <input
              type="text"
              value={data.tileUrl}
              readOnly
              onFocus={(e) => e.target.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => void copyTileUrl()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
            >
              {copied ? (
                <Check className="h-4 w-4 text-accent" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      ) : null}

      {/* Preview map */}
      {ready ? <TilePreview data={data} /> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <p className="text-2xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-ink-0">{value}</p>
    </div>
  );
}

/**
 * Small MapLibre preview rendering the tile layer via the
 * pmtiles:// protocol. For raster caches it adds a raster source
 * + layer; for vector caches it adds a vector source + a
 * placeholder fill layer (vector content needs a real style to
 * render meaningfully; this surfaces "tiles are served" without
 * pretending to know the source-layer schema).
 */
function TilePreview({ data }: { data: TileLayerData }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const center: [number, number] =
      data.centerLng !== undefined && data.centerLat !== undefined
        ? [data.centerLng, data.centerLat]
        : data.bbox
          ? [
              (data.bbox[0] + data.bbox[2]) / 2,
              (data.bbox[1] + data.bbox[3]) / 2,
            ]
          : [0, 0];
    const initialZoom =
      data.centerZoom ??
      (data.minZoom !== undefined ? data.minZoom : 1);

    // Build a minimal style that includes a neutral backdrop +
    // the pmtiles layer. The backdrop is OSM raster so the user
    // can see geography even when the cache covers a small region
    // (a county-level cache against a black background reads as
    // "nothing here"; the OSM context fixes that).
    const isRaster = data.kind === 'raster';
    const style: maplibregl.StyleSpecification = {
      version: 8,
      sources: {
        backdrop: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '(c) OpenStreetMap contributors',
        },
        ...(isRaster
          ? ({
              tilecache: {
                type: 'raster',
                url: data.tileUrl ?? '',
                tileSize: 256,
                ...(data.minZoom !== undefined
                  ? { minzoom: data.minZoom }
                  : {}),
                ...(data.maxZoom !== undefined
                  ? { maxzoom: data.maxZoom }
                  : {}),
                ...(data.attribution
                  ? { attribution: data.attribution }
                  : {}),
              },
            } as maplibregl.StyleSpecification['sources'])
          : ({
              tilecache: {
                type: 'vector',
                url: data.tileUrl ?? '',
                ...(data.minZoom !== undefined
                  ? { minzoom: data.minZoom }
                  : {}),
                ...(data.maxZoom !== undefined
                  ? { maxzoom: data.maxZoom }
                  : {}),
                ...(data.attribution
                  ? { attribution: data.attribution }
                  : {}),
              },
            } as maplibregl.StyleSpecification['sources'])),
      },
      layers: [
        { id: 'backdrop', type: 'raster', source: 'backdrop' },
        isRaster
          ? {
              id: 'tilecache-raster',
              type: 'raster',
              source: 'tilecache',
              paint: { 'raster-opacity': 0.9 },
            }
          : {
              id: 'tilecache-vector-debug',
              type: 'line',
              source: 'tilecache',
              // No source-layer specified, MapLibre renders all
              // layers in the tile. Acceptable for a preview;
              // production consumers configure source-layer +
              // style per layer.
              'source-layer': '',
              paint: { 'line-color': '#7c3aed', 'line-width': 1 },
            },
      ],
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center,
      zoom: initialZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border bg-surface-2 px-4 py-3">
        <h3 className="text-sm font-medium text-ink-0">Preview</h3>
        <p className="mt-0.5 text-xs text-muted">
          Rendered through the API&rsquo;s pmtiles proxy. Pan and zoom
          to verify the cache covers what you expect.
        </p>
      </div>
      <div ref={containerRef} className="h-[420px] w-full bg-surface-0" />
    </section>
  );
}

function originalFormatLabel(fmt: TileLayerOriginalFormat): string {
  switch (fmt) {
    case 'pmtiles':
      return 'PMTiles';
    case 'mbtiles':
      return 'MBTiles';
    case 'xyz-zip':
      return 'XYZ tile directory (zip)';
    case 'geotiff':
      return 'GeoTIFF';
    case 'cog':
      return 'GeoTIFF image';
    case 'jp2':
      return 'JPEG 2000';
  }
}

/** Friendly relative-time renderer for tilingStartedAt /
 *  tilingCompletedAt timestamps in the status block.  Falls back
 *  to the raw ISO string when the value isn't a parseable date. */
function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return d.toLocaleString();
}

/**
 * JSON.stringify with object keys sorted at every level, so two
 * structurally equal payloads serialize identically regardless of
 * the key order the server happened to emit.  Used by the status
 * poll to detect "nothing actually changed" ticks.  Both operands
 * are JSON-derived (RSC-serialized prop or res.json()), so
 * undefined never appears in practice; objects drop undefined
 * members to mirror JSON.stringify semantics anyway.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

