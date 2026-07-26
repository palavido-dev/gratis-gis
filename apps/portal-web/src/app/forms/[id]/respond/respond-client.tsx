// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudOff, RefreshCcw, Wifi } from 'lucide-react';
import type { FormSchema, Response } from '@gratis-gis/form-schema';
import { FormRuntime } from '@/components/form-runtime';
import {
  drain,
  listQueued,
  queueSubmission,
  type QueuedSubmission,
} from '@/lib/form-offline';
import { uploadPendingAttachmentsInResponse } from '@/lib/form-attachment-upload';
import { requestBackgroundSync } from '@/lib/offline-store';

interface Props {
  form: FormSchema;
  formItemTitle: string;
}

/**
 * Client wrapper around FormRuntime that handles online/offline,
 * IndexedDB queueing, and outbox surfacing.
 *
 * Submission strategy:
 *   1. Always queue first (IndexedDB) so submissions survive a
 *      crash / page-close.
 *   2. If online, immediately attempt to drain the queue against
 *      the server. The newly-queued row goes through the same
 *      drain path as anything stale.
 *   3. If offline, leave it queued; the periodic check (or the
 *      next online event) will drain.
 *   4. Every queue write also arms the service worker's one-shot
 *      Background Sync tag, so on Chromium the row still replays if
 *      the tab closes before connectivity returns. The worker's
 *      drain (public/sw.js) marks rows 'sent'/'failed' in the same
 *      IndexedDB, and this outbox already re-reads statuses on every
 *      refresh, so the two drains coexist; duplicate sends collapse
 *      server-side via the (formId, clientId) upsert. Rows carrying
 *      offline-captured attachments are skipped by the worker (they
 *      need the presign upload walk below) and drain here instead.
 *
 * Server-side endpoint: POST /api/portal/forms/:id/submissions with
 *   { clientId, schemaVersion, response, capturedAt }
 * Idempotent on clientId at the server (a re-drained row is a no-op).
 */
export function RespondClient({ form, formItemTitle }: Props) {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [outbox, setOutbox] = useState<QueuedSubmission[]>([]);
  const [draining, setDraining] = useState(false);
  // Concurrency guard for drainOnce. Held in a ref, not read from
  // the `draining` state: state in the callback would put it in the
  // dep array, so every drain would mint a new drainOnce identity,
  // re-run the mount effect below, and kick off the next drain in
  // an endless loop. The state copy exists purely for the UI.
  const drainingRef = useRef(false);

  const refreshOutbox = useCallback(async () => {
    try {
      const all = await listQueued();
      setOutbox(all.filter((r) => r.formId === form.id && r.status !== 'sent'));
    } catch {
      // IndexedDB unavailable (private browsing, etc); runtime still
      // works for online-only submissions.
    }
  }, [form.id]);

  const drainOnce = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setDraining(true);
    try {
      await drain(form.id, async (row) => {
        // Upload any offline-captured attachments before posting (#280).
        // The walk mutates row.response in place so a partial drain
        // (some attachments uploaded, some still pending) doesn't have
        // to redo successful uploads on retry. uploadPendingAttachments
        // throws on failure; the outer drain marks the row failed and
        // the queue will retry next online tick.
        await uploadPendingAttachmentsInResponse(row.response);
        const res = await fetch(
          `/api/portal/forms/${form.id}/submissions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              clientId: row.clientId,
              schemaVersion: row.schemaVersion,
              response: row.response,
              capturedAt: row.capturedAt,
            }),
          },
        );
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
        }
      });
    } finally {
      drainingRef.current = false;
      setDraining(false);
      await refreshOutbox();
    }
  }, [form.id, refreshOutbox]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void drainOnce();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void refreshOutbox();
    if (navigator.onLine) void drainOnce();
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [drainOnce, refreshOutbox]);

  async function handleSubmit(response: Response) {
    await queueSubmission({
      formId: form.id,
      schemaVersion: form.schemaVersion,
      response,
    });
    // Arm background replay in case the tab closes before we get a
    // network (no-op off Chromium; see strategy note above).
    requestBackgroundSync();
    await refreshOutbox();
    if (navigator.onLine) {
      // Best-effort drain. If it fails the row stays queued and the
      // user sees it in the outbox.
      await drainOnce();
    }
  }

  return (
    <div className="min-h-screen bg-surface-0">
      <div className="border-b border-border bg-surface-1 px-4 py-2 text-xs text-ink-1">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-2">
          <span className="truncate">{formItemTitle}</span>
          <span
            className={`inline-flex items-center gap-1 ${
              online ? 'text-success' : 'text-warn'
            }`}
          >
            {online ? <Wifi className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      <FormRuntime form={form} onSubmit={handleSubmit} submitLabel="Submit" />

      {outbox.length > 0 ? (
        <div className="mx-auto w-full max-w-xl px-4 py-4">
          <div className="rounded-md border border-border bg-surface-1 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Outbox ({outbox.length})
              </p>
              <button
                type="button"
                onClick={() => void drainOnce()}
                disabled={draining || !online}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                <RefreshCcw className="h-3 w-3" />
                {draining ? 'Sending...' : online ? 'Try again' : 'Offline'}
              </button>
            </div>
            <ul className="space-y-1.5 text-xs">
              {outbox.map((r) => (
                <li
                  key={r.clientId}
                  className="flex items-start justify-between gap-2 rounded border border-border bg-surface-0 px-2 py-1"
                >
                  <span className="truncate">
                    {new Date(r.capturedAt).toLocaleString()}
                  </span>
                  <span
                    className={`inline-flex rounded-full px-1.5 text-2xs uppercase tracking-wide ${
                      r.status === 'failed'
                        ? 'bg-warn/15 text-warn'
                        : 'bg-surface-2 text-muted'
                    }`}
                  >
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
