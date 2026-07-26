// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
} from 'lucide-react';
import { useConfirm } from '@/components/dialog-provider';

interface Attachment {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string;
  createdAt: string;
  createdBy: string;
}

interface Props {
  itemId: string;
  layerId: string;
  featureId: string;
  canEdit: boolean;
}

/**
 * Per-feature attachment gallery + uploader.
 *
 * Upload flow matches the rest of the app:
 *  1. POST /storage/presign-upload { kind: 'feature-attachment', contentType }
 *     → { uploadUrl, publicUrl, key, maxBytes }
 *  2. PUT the bytes directly to MinIO (uploadUrl). The API never
 *     buffers the bytes.
 *  3. POST /items/:id/layers/:layerId/features/:fid/attachments
 *     { fileName, mime, sizeBytes, storageKey, storageUrl } to
 *     register the metadata.
 *
 * Images render as thumbnails (uses the publicUrl directly; MinIO
 * serves them). Non-images render an icon + filename. Delete removes
 * the metadata row; the storage.service also best-effort deletes the
 * underlying MinIO object.
 */
export function V3FeatureAttachments({
  itemId,
  layerId,
  featureId,
  canEdit,
}: Props) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const confirm = useConfirm();

  const basePath = `/api/portal/items/${itemId}/layers/${layerId}/features/${featureId}/attachments`;

  // The mount effect passes an abort signal so a fast unmount or a
  // feature flip cancels the in-flight request instead of letting a
  // stale response land on the next feature's gallery. Callers
  // refreshing after a mutation omit the signal.
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(basePath, signal ? { signal } : {});
        if (!res.ok) {
          setError(`Could not load attachments: ${res.status}`);
          return;
        }
        const body = (await res.json()) as Attachment[];
        if (signal?.aborted) return;
        setItems(body);
      } catch (err) {
        // Abort means the component moved on; anything else (network
        // drop, JSON parse) deserves a visible message instead of an
        // unhandled rejection that leaves the gallery stuck empty.
        if ((err as Error)?.name === 'AbortError') return;
        setError(
          (err as Error).message || 'Could not load attachments',
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [basePath],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      // 1. Presign.
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'feature-attachment',
          contentType: file.type || 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        setError(`Could not start upload: ${presignRes.status}`);
        return;
      }
      const presign = (await presignRes.json()) as {
        uploadUrl: string;
        publicUrl: string;
        key: string;
        maxBytes: number;
      };
      if (file.size > presign.maxBytes) {
        setError(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; limit is ${(
            presign.maxBytes /
            1024 /
            1024
          ).toFixed(0)} MB.`,
        );
        return;
      }

      // 2. PUT to MinIO.
      const putRes = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      if (!putRes.ok) {
        setError(`Upload failed: ${putRes.status}`);
        return;
      }

      // 3. Register metadata.
      const regRes = await fetch(basePath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mime: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          storageKey: presign.key,
          storageUrl: presign.publicUrl,
        }),
      });
      if (!regRes.ok) {
        setError(`Could not register attachment: ${regRes.status}`);
        return;
      }
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function remove(a: Attachment) {
    const ok = await confirm({
      title: 'Delete attachment?',
      message: `Delete ${a.fileName}? This cannot be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setError(null);
    const res = await fetch(`${basePath}/${a.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(`Delete failed: ${res.status}`);
      return;
    }
    await reload();
  }

  return (
    <div className="rounded border border-border bg-surface-0 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted">
          <Paperclip className="h-3 w-3" />
          Attachments
          {!loading && items.length > 0 ? ` · ${items.length}` : ''}
        </p>
        {canEdit ? (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              Upload
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p className="mb-1.5 inline-flex items-center gap-1 text-2xs text-danger">
          <AlertTriangle className="h-3 w-3" />
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="px-1 py-2 text-2xs text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-1 py-2 text-2xs text-muted">
          {canEdit
            ? 'No attachments yet. Upload photos, PDFs, or other files up to 25 MB.'
            : 'No attachments yet.'}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((a) => {
            const isImage = a.mime.startsWith('image/');
            return (
              <li
                key={a.id}
                className="group relative overflow-hidden rounded border border-border bg-surface-1"
              >
                <a
                  href={a.storageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                  title={a.fileName}
                >
                  {isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.storageUrl}
                      alt={a.fileName}
                      className="h-20 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-full items-center justify-center bg-surface-2 text-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                  )}
                </a>
                <div className="flex items-start justify-between gap-1 border-t border-border p-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-2xs text-ink-1" title={a.fileName}>
                      {isImage ? (
                        <ImageIcon className="mr-1 inline h-3 w-3 text-muted" />
                      ) : null}
                      {a.fileName}
                    </p>
                    <p className="text-2xs text-muted">
                      {formatSize(a.sizeBytes)}
                    </p>
                  </div>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => void remove(a)}
                      title="Delete attachment"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
