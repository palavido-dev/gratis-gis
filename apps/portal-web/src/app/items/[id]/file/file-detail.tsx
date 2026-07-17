// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Download, FileText, ImageIcon, FileType2 } from 'lucide-react';
import type { FileData } from '@gratis-gis/shared-types';
import { CopyUrlButton } from './copy-url-button';

/**
 * File item detail body (#296). Two parts:
 *   1. A metadata card: filename, MIME, size, upload time, plus the
 *      Download affordance.
 *   2. An optional inline preview. Images render in an <img>; PDFs
 *      get an <iframe>; everything else falls back to a generic
 *      "no preview" tile so the user still sees the file's identity.
 *
 * The Download button uses Content-Disposition via the `download`
 * attribute so the browser saves with the original filename rather
 * than the random storage UUID. The href is the public MinIO URL --
 * gating is by item visibility (the item-detail page already 404s
 * for users who can't see it).
 */
export function FileDetail({ data, canDownload }: { data: FileData; canDownload: boolean }) {
  const previewKind = pickPreviewKind(data.mimeType);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <FilePreviewIcon kind={previewKind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink-0" title={data.fileName}>
            {data.fileName || '(unnamed file)'}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span>{humanFileSize(data.sizeBytes)}</span>
            <span className="font-mono">{data.mimeType}</span>
            {data.uploadedAt ? (
              <span>uploaded {formatRelative(data.uploadedAt)}</span>
            ) : null}
          </div>
        </div>
        {data.storageUrl ? (
          // Copy URL is available to anyone who can see the item.
          // The URL itself isn't a secret — it's the public-ish
          // MinIO link that the runtime resolves for embedded
          // images. Gating is by item visibility (the item-detail
          // page already 404s for users who can't see it).
          <CopyUrlButton url={data.storageUrl} />
        ) : null}
        {canDownload && data.storageUrl ? (
          <a
            // Anchor `download` only honors a same-origin filename hint
            // unless the response sets Content-Disposition; MinIO's
            // bucket policy serves objects with their stored name (the
            // UUID key). Pass the original filename here so the
            // browser at least suggests it on save.
            href={data.storageUrl}
            download={data.fileName || undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        ) : (
          <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 text-xs text-muted">
            View only
          </span>
        )}
      </div>

      {previewKind === 'image' && data.storageUrl ? (
        <div className="rounded-lg border border-border bg-surface-2 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- the
              MinIO origin isn't in next.config images.domains; using a
              raw <img> avoids forcing every operator to whitelist
              their MinIO host. */}
          <img
            src={data.storageUrl}
            alt={data.fileName}
            className="mx-auto max-h-[60vh] max-w-full rounded"
          />
        </div>
      ) : null}

      {previewKind === 'pdf' && data.storageUrl ? (
        <div className="rounded-lg border border-border bg-surface-2 p-2">
          <iframe
            src={data.storageUrl}
            title={data.fileName}
            className="h-[70vh] w-full rounded border border-border bg-white"
          />
          <p className="mt-2 text-2xs text-muted">
            Preview from your portal&rsquo;s storage. Use Download to grab a copy.
          </p>
        </div>
      ) : null}

      {previewKind === 'other' && data.storageUrl ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 p-4 text-center text-xs text-muted">
          No inline preview for this file type.{' '}
          {canDownload ? (
            <Link
              href={data.storageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Open in a new tab
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FilePreviewIcon({ kind }: { kind: PreviewKind }) {
  if (kind === 'image') return <ImageIcon className="h-6 w-6 shrink-0 text-accent" />;
  if (kind === 'pdf') return <FileType2 className="h-6 w-6 shrink-0 text-accent" />;
  return <FileText className="h-6 w-6 shrink-0 text-accent" />;
}

type PreviewKind = 'image' | 'pdf' | 'other';

function pickPreviewKind(mime: string): PreviewKind {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const ms = Date.now() - d.getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
