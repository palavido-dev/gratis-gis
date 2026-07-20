// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Upload as UploadIcon,
} from 'lucide-react';
import type {
  TileLayerData,
  TileLayerOriginalFormat,
} from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Poll the item while the pyramid build is in flight.  States
  // that should trigger refresh: 'cog-ready' (waiting for the
  // worker to pick it up) and 'tiling' (job is running).
  // Terminal states ('pmtiles-ready', 'tiling-failed') don't
  // trigger polling.  Polling stops when the component unmounts
  // OR when the state advances out of a transient value.
  const transientState =
    data.processingState === 'cog-ready' ||
    data.processingState === 'tiling';
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
          setData(body.item.data);
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

  // Register the pmtiles and cog protocols with MapLibre once
  // per page load.  pmtiles serves PMTiles archives via range
  // requests; cog serves Cloud-Optimized GeoTIFFs the same way
  // (powering the bridge state for raw raster uploads waiting on
  // their PMTiles pyramid).  Idempotent registration so HMR re-
  // renders don't double-register.
  useEffect(() => {
    const proto = new Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);
    maplibregl.addProtocol(
      'cog',
      cogProtocol as unknown as Parameters<typeof maplibregl.addProtocol>[1],
    );
    return () => {
      maplibregl.removeProtocol('pmtiles');
      maplibregl.removeProtocol('cog');
    };
  }, []);

  async function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be selected twice (a
    // re-upload of the same name shouldn't be silently ignored).
    ev.target.value = '';
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
            Everything is prepared automatically so maps can
            display it quickly. TPK / TPKX, ECW, and MrSID
            aren&rsquo;t supported.
          </p>
        </div>
        <div className="space-y-3 p-4 text-sm">
          {ready ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline gap-2 text-ink-0">
                <span className="font-medium">{data.fileName}</span>
                <span className="text-xs text-muted">
                  {humanSize(data.sizeBytes)}
                </span>
              </div>
              {data.name || data.description ? (
                <p className="text-xs text-muted">
                  {data.name ? <strong>{data.name}</strong> : null}
                  {data.name && data.description ? ' — ' : ''}
                  {data.description ?? null}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted">
              No tile file uploaded yet.
            </p>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void pickFile()}
                disabled={uploading}
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
                  ? `Uploading ${uploadProgress}%...`
                  : ready
                    ? 'Replace file'
                    : 'Upload file'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pmtiles,.mbtiles,.zip,.tif,.tiff,.geotiff,.cog,.jp2"
                onChange={(e) => void onFileChange(e)}
                className="hidden"
              />
            </div>
          ) : null}
          {uploadError ? (
            <p className="text-xs text-danger" role="alert">
              {uploadError}
            </p>
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
                    ? 'This elevation layer is ready. Pick it under the basemap button in a map to turn on 3D terrain.'
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
                    ? humanSize(data.cogSizeBytes)
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
            <Metric label="Size on disk" value={humanSize(data.sizeBytes)} />
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

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
