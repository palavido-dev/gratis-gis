// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Photos and files on a feature, from the field.
 *
 * The portal already has an attachment gallery
 * (data-layer/v3-feature-attachments.tsx) and this is not it, for two
 * reasons that are about the job rather than the styling:
 *
 *   1. **It only worked online.** Its upload is a presign, a PUT and a
 *      register, all of which need a network. Offline, the button did
 *      nothing useful. For inspection work the photograph often IS the
 *      record, so a collection app that cannot take one without signal
 *      is not a collection app.
 *   2. **It only worked in edit mode.** The attachment endpoint is
 *      keyed by feature id, so a feature being created had nothing to
 *      attach to and the gallery was hidden. That put the camera one
 *      save-and-reopen away from the moment the collector is standing
 *      in front of the thing they are photographing.
 *
 * Queueing solves both. A captured file is written to IndexedDB
 * against the feature's client-generated globalId, which exists from
 * the moment the collect form opens, and the sync drain uploads it
 * once the feature itself has landed. So capture works the same way
 * with or without signal, and in add mode as well as edit.
 *
 * What renders is the union of two lists: attachments the server
 * already holds (fetched when online and the feature exists) and
 * files still waiting on this device. The waiting ones are marked,
 * because "is this photo safely off my phone" is a question a
 * collector genuinely needs answered before they drive home.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CloudOff,
  FileText,
  Loader2,
  Paperclip,
  Trash2,
} from 'lucide-react';
import { useConfirm } from '@/components/dialog-provider';
import {
  deletePendingBlob,
  listPendingBlobsForFeature,
  newUuid,
  putPendingBlob,
  type PendingBlob,
} from '@/lib/offline-store';
import { formatBytes } from '@/lib/format-bytes';
import { useT } from '@/lib/i18n/locale-context';
import { tapFeedback } from './field-sheet';

interface ServerAttachment {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string;
}

interface Props {
  dataCollectionId: string;
  dataLayerId: string;
  layerKey: string;
  /** The feature's globalId. In add mode this is the client-generated
   *  id the form will submit with, which is exactly why capture can
   *  happen before the feature exists anywhere. */
  globalId: string;
  /** False in add mode: there is no server row to read from yet. */
  featureExistsOnServer: boolean;
  isOnline: boolean;
  /**
   * Whether to offer the camera. False in the tap-a-feature popup,
   * which is a read view; capture lives behind its Edit action.
   *
   * The popup still renders PENDING files, which is the point of
   * showing it there at all: a collector who has just photographed
   * something and taps it on the map should see the photo, not an
   * empty gallery, and offline the server list is empty by
   * definition.
   */
  canCapture?: boolean;
}

export function FieldAttachments({
  dataCollectionId,
  dataLayerId,
  layerKey,
  globalId,
  featureExistsOnServer,
  isOnline,
  canCapture = true,
}: Props) {
  const [uploaded, setUploaded] = useState<ServerAttachment[]>([]);
  const [pending, setPending] = useState<PendingBlob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const confirm = useConfirm();
  const t = useT();

  const basePath = `/api/portal/items/${dataLayerId}/layers/${encodeURIComponent(
    layerKey,
  )}/features/${globalId}/attachments`;

  const reloadPending = useCallback(async () => {
    try {
      setPending(
        await listPendingBlobsForFeature(
          dataCollectionId,
          dataLayerId,
          layerKey,
          globalId,
        ),
      );
    } catch {
      // IndexedDB refused. The capture button still works against the
      // network when there is one; surfacing a storage error here
      // would be noise on top of whatever the runtime already shows.
    }
  }, [dataCollectionId, dataLayerId, layerKey, globalId]);

  useEffect(() => {
    void reloadPending();
  }, [reloadPending]);

  // Server-side list. Skipped entirely offline and in add mode, where
  // there is nothing to ask for and asking would just log a failure.
  useEffect(() => {
    if (!isOnline || !featureExistsOnServer) {
      setUploaded([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(basePath, { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as ServerAttachment[];
        if (controller.signal.aborted) return;
        setUploaded(body);
      } catch {
        // Abort, or the network went while we asked. The pending list
        // is the part that matters offline and it is unaffected.
      }
    })();
    return () => controller.abort();
  }, [basePath, isOnline, featureExistsOnServer]);

  async function capture(file: File) {
    setError(null);
    setBusy(true);
    try {
      await putPendingBlob({
        blobId: newUuid(),
        dataCollectionId,
        dataLayerId,
        layerKey,
        globalId,
        fileName: file.name || `capture-${Date.now()}.jpg`,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        blob: file,
        capturedAt: new Date().toISOString(),
      });
      tapFeedback();
      await reloadPending();
    } catch (err) {
      // Almost always the storage quota. Say so rather than "failed":
      // the collector can free space, and cannot act on a shrug.
      const quota =
        err && typeof err === 'object' && (err as { name?: string }).name ===
          'QuotaExceededError';
      setError(
        quota
          ? t('fieldAttachments.quotaError')
          : t('fieldAttachments.saveError', {
              reason: err instanceof Error ? err.message : 'unknown error',
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function discardPending(row: PendingBlob) {
    const ok = await confirm({
      title: t('fieldAttachments.discardTitle'),
      message: t('fieldAttachments.discardMessage', { name: row.fileName }),
      confirmLabel: t('fieldAttachments.discardAction'),
      variant: 'danger',
    });
    if (!ok) return;
    await deletePendingBlob(row.blobId);
    await reloadPending();
  }

  const total = uploaded.length + pending.length;

  return (
    <div className="rounded-md border border-border bg-surface-0 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
          <Paperclip className="h-3.5 w-3.5" />
          {total > 0
            ? t('fieldAttachments.headingCount', { count: total })
            : t('fieldAttachments.heading')}
        </p>
        {canCapture ? (
          <>
            {/* capture="environment" asks for the rear camera
                directly, which is the one pointed at the thing being
                recorded. It degrades to a normal file picker on
                desktop. */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void capture(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
              {t('fieldAttachments.add')}
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="mb-2 flex items-start gap-1 text-2xs text-danger"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {error}
        </p>
      ) : null}

      {total === 0 ? (
        <p className="px-1 py-2 text-2xs text-muted">
          {canCapture
            ? t('fieldAttachments.emptyCanCapture')
            : t('fieldAttachments.emptyReadOnly')}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {pending.map((row) => (
            <PendingTile
              key={row.blobId}
              row={row}
              {...(canCapture
                ? { onDiscard: () => void discardPending(row) }
                : {})}
            />
          ))}
          {uploaded.map((a) => (
            <li
              key={a.id}
              className="overflow-hidden rounded-md border border-border bg-surface-1"
            >
              <a href={a.storageUrl} target="_blank" rel="noreferrer">
                {a.mime.startsWith('image/') ? (
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
              <p className="truncate px-1.5 py-1 text-2xs text-muted">
                {formatBytes(a.sizeBytes)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One not-yet-uploaded file.
 *
 * Renders the real image from the stored Blob so the collector can
 * see what they actually took, rather than a placeholder standing in
 * for it. The object URL is revoked on unmount; a form reopened
 * twenty times over a shift would otherwise hold every preview it had
 * ever made.
 */
function PendingTile({
  row,
  onDiscard,
}: {
  row: PendingBlob;
  /** Omitted in the read-only popup, where discarding would be a
   *  destructive action on a surface that offers no others. */
  onDiscard?: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!row.mimeType.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(row.blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [row.blob, row.mimeType]);

  return (
    <li className="relative overflow-hidden rounded-md border border-warn/40 bg-surface-1">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={row.fileName} className="h-20 w-full object-cover" />
      ) : (
        <div className="flex h-20 w-full items-center justify-center bg-surface-2 text-muted">
          <FileText className="h-6 w-6" />
        </div>
      )}
      <span
        className="absolute left-1 top-1 inline-flex items-center gap-1 rounded-full bg-warn/90 px-1.5 py-0.5 text-2xs font-medium text-white"
        title={t('fieldAttachments.pendingBadgeTitle')}
      >
        <CloudOff className="h-3 w-3" />
        {t('fieldAttachments.pendingBadge')}
      </span>
      <div className="flex items-center justify-between gap-1 px-1.5 py-1">
        <span className="truncate text-2xs text-muted">
          {formatBytes(row.sizeBytes)}
        </span>
        {onDiscard ? (
          <button
            type="button"
            onClick={onDiscard}
            aria-label={t('fieldAttachments.discardLabel', {
              name: row.fileName,
            })}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger active:bg-danger/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
