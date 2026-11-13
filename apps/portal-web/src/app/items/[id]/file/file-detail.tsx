// SPDX-License-Identifier: AGPL-3.0-or-later
import { RelativeTime } from '@/components/relative-time';
import Link from 'next/link';
import { Download, FileText, ImageIcon, FileType2 } from 'lucide-react';
import type { FileData } from '@gratis-gis/shared-types';
import { CopyUrlButton } from './copy-url-button';
import { formatBytes } from '@/lib/format-bytes';

/**
 * File item detail body (#296). Two parts:
 *   1. A metadata card: filename, MIME, size, upload time, plus the
 *      Download affordance.
 *   2. An optional inline preview. Images render in an <img>; PDFs
 *      get an <iframe>; everything else falls back to a generic
 *      "no preview" tile so the user still sees the file's identity.
 *
 * `storageUrl` is the portal's private file route
 * (/api/portal/storage/private/item-file/<key>), on this origin. It
 * checks read access on the item and sends the original filename in
 * Content-Disposition. It does not apply the download tier: anyone
 * who can see the item can fetch the file. Hiding Download and showing
 * "View only" is a hint, not a lock (a product decision, kept).
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
            <span>{formatBytes(data.sizeBytes)}</span>
            <span className="font-mono">{data.mimeType}</span>
            {data.uploadedAt ? (
              <span>uploaded <RelativeTime value={data.uploadedAt} /></span>
            ) : null}
          </div>
        </div>
        {data.storageUrl ? (
          // Copy URL is available to anyone who can see the item. The
          // route behind it checks read access on every request, so
          // the link is no use to someone who cannot see the item.
          <CopyUrlButton url={data.storageUrl} />
        ) : null}
        {canDownload && data.storageUrl ? (
          <a
            // The route sends the original filename in
            // Content-Disposition; `download` repeats it for browsers
            // that read the attribute first.
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
          {/* eslint-disable-next-line @next/next/no-img-element -- a
              plain <img> of the file route, so the request goes
              straight to it with the viewer's session. */}
          <img
            src={data.storageUrl}
            alt={data.fileName}
            className="mx-auto max-h-[60vh] max-w-full rounded"
          />
        </div>
      ) : null}

      {previewKind === 'pdf' && data.storageUrl ? (
        <div className="rounded-lg border border-border bg-surface-2 p-2">
          {/* `inline=1` makes the route serve the PDF in the page,
              under a sandbox policy, instead of as a download. */}
          <iframe
            src={inlinePdfUrl(data.storageUrl)}
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

function inlinePdfUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}inline=1`;
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

