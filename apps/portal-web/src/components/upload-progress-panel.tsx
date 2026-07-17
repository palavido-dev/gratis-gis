// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { FileUp, Loader2, XCircle } from 'lucide-react';

/**
 * Shared upload-progress UI + helper. Used wherever a sizeable file
 * goes to the server: the data-layer wizard's probe panel, the
 * detail-page Import features button, anywhere else we'd otherwise
 * leave the user staring at a tiny gray "Working..." line.
 *
 * The panel is intentionally tall and visually loud so the user
 * cannot mistake it for a static label. A 200 MB shapefile zip can
 * spend a minute uploading on cellular and then another minute or
 * more being parsed by GDAL on the server; the user needs to see
 * what's happening at every step.
 *
 * Three phases:
 *   parsing   - file is being parsed in the main thread (GeoJSON
 *               only). Indeterminate spinner; no progress bar.
 *   uploading - bytes are climbing to the server. Bar from 0 to 100
 *               driven by XMLHttpRequest upload events.
 *   reading   - upload is done, server-side work is happening
 *               (GDAL probe, PostGIS bulk insert, etc.). Bar sits
 *               at 100 with a subtle pulse to telegraph "still
 *               working" without lying about ETA.
 */
export interface UploadBusy {
  phase: 'parsing' | 'uploading' | 'reading';
  fileName: string;
  fileSize: number;
  bytesUploaded: number;
  /** Optional override for the panel copy. The defaults read like
   *  "Reading on the server" (probe / wizard); a caller doing a
   *  feature ingest can pass its own to read like "Importing
   *  features into PostGIS". */
  copy?: Partial<
    Record<
      UploadBusy['phase'],
      { headline?: string; subhead?: string }
    >
  >;
}

const DEFAULT_COPY: Record<
  UploadBusy['phase'],
  { headline: string; subhead: string }
> = {
  parsing: {
    headline: 'Parsing locally',
    subhead: 'Reading the file in your browser. This is fast for GeoJSON.',
  },
  uploading: {
    headline: 'Uploading',
    subhead:
      'Sending the file to the server. Larger files take longer; cellular is slower than wifi.',
  },
  reading: {
    headline: 'Reading on the server',
    subhead:
      'GDAL is opening the archive and listing layers. This can take a minute for a county-scale parcel layer.',
  },
};

export function UploadProgressPanel({
  busy,
  onCancel,
}: {
  busy: UploadBusy;
  onCancel: () => void;
}) {
  const pct =
    busy.phase === 'uploading' && busy.fileSize > 0
      ? Math.min(100, (busy.bytesUploaded / busy.fileSize) * 100)
      : busy.phase === 'reading'
        ? 100
        : 0;
  const customCopy = busy.copy?.[busy.phase];
  const baseCopy = DEFAULT_COPY[busy.phase];
  const headline =
    customCopy?.headline ??
    (busy.phase === 'uploading'
      ? `${baseCopy.headline} ${pct.toFixed(0)}%`
      : baseCopy.headline);
  const subhead = customCopy?.subhead ?? baseCopy.subhead;
  const showCancel = busy.phase !== 'parsing';
  return (
    <div className="rounded border border-border bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          {busy.phase === 'uploading' ? (
            <FileUp className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-0">
            {headline}
          </p>
          <p className="mt-0.5 truncate text-2xs text-muted">
            <span className="font-medium text-ink-1">{busy.fileName}</span>
            {busy.fileSize > 0 ? (
              <span> · {formatBytesSimple(busy.fileSize)}</span>
            ) : null}
          </p>
          <p className="mt-1.5 text-2xs text-muted">{subhead}</p>
          {busy.phase !== 'parsing' ? (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full bg-accent transition-all ${
                  busy.phase === 'reading' ? 'animate-pulse' : ''
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : null}
          {busy.phase === 'uploading' ? (
            <p className="mt-1 text-2xs text-muted">
              {formatBytesSimple(busy.bytesUploaded)} of{' '}
              {formatBytesSimple(busy.fileSize)}
            </p>
          ) : null}
        </div>
        {showCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface-0 px-2 py-1 text-2xs text-ink-1 hover:bg-surface-2"
          >
            <XCircle className="h-3 w-3" />
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * XHR-driven upload helper. fetch() has no upload-progress hook, so
 * we use XMLHttpRequest. Resolves with parsed JSON or rejects with an
 * Error (.name === 'AbortError' on user cancel).
 *
 * `ref` is used so the caller can keep a reference to the live xhr
 * and call `.abort()` from a Cancel button. Pass `{ current: null }`
 * if you don't need cancel.
 */
export async function uploadWithProgress<T>(
  url: string,
  file: File,
  onProgress: (e: {
    phase: 'uploading' | 'reading';
    bytesUploaded: number;
  }) => void,
  ref: { current: XMLHttpRequest | null } = { current: null },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    ref.current = xhr;
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        if (ev.loaded < ev.total) {
          onProgress({ phase: 'uploading', bytesUploaded: ev.loaded });
        } else {
          onProgress({ phase: 'reading', bytesUploaded: ev.total });
        }
      }
    };
    xhr.upload.onload = () => {
      onProgress({ phase: 'reading', bytesUploaded: file.size });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch (err) {
          reject(
            new Error(
              `Server response was not JSON: ${(err as Error).message}`,
            ),
          );
        }
      } else {
        reject(
          new Error(
            `Upload failed (${xhr.status}): ${
              xhr.responseText || xhr.statusText || 'no body'
            }`,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.onabort = () => {
      const e = new Error('Upload cancelled.');
      e.name = 'AbortError';
      reject(e);
    };
    const body = new FormData();
    body.append('file', file);
    xhr.send(body);
  });
}

/** Tiny byte formatter so the panel doesn't reach into offline-store
 *  helpers (which would also pull IDB code into bundles that don't
 *  need it). */
export function formatBytesSimple(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}
