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
  isAnonymousSubmission,
  updateQueuedResponse,
} from '@/lib/form-offline';
import { getOfflineIdentity } from '@/lib/offline-store';
import { uploadQueuedAttachments } from '@/lib/form-attachment-upload';
import { requestBackgroundSync } from '@/lib/offline-store';
import { useFormat } from '@/lib/i18n/format';
import { apiErrorMessage } from '@/lib/api-error';

interface Props {
  form: FormSchema;
  /** The form item id from the route. Responses are queued and sent
   *  under this, not the schema's own `id`, which only matches the
   *  item id by convention and is not enforced on save. */
  formId: string;
  formItemTitle: string;
  /** The signed-in account from the server render, when known. It
   *  wins over the device identity, which the guard may not have
   *  updated yet after an account switch. */
  userId?: string | null;
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
 *   3. If offline, leave it queued; the next online event, the
 *      next submit or "Try again" will drain. A submit during a
 *      running drain makes that drain go round once more.
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
/**
 * The account this device belongs to (set by OfflineIdentityGuard).
 * Queued responses are stamped with it and only this account's rows
 * are listed or sent, so a shared device never posts one person's
 * answers under the next person's session. Null when nobody is signed
 * in or the offline store is unavailable.
 */
async function deviceIdentity(): Promise<string | null> {
  try {
    return await getOfflineIdentity();
  } catch {
    return null;
  }
}

export function RespondClient({ form, formId, formItemTitle, userId = null }: Props) {
  // A response is stamped with, listed for and sent as this account.
  // With no account known it is stored as captured anonymously and
  // held (see ANONYMOUS_SUBMISSION_OWNER in form-offline.ts).
  const currentIdentity = useCallback(
    async (): Promise<string | null> => userId ?? (await deviceIdentity()),
    [userId],
  );
  const fmt = useFormat();
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
  const rerunRef = useRef(false);

  const refreshOutbox = useCallback(async () => {
    try {
      const all = await listQueued(await currentIdentity());
      setOutbox(all.filter((r) => r.formId === formId && r.status !== 'sent'));
    } catch {
      // IndexedDB unavailable (private browsing, etc); runtime still
      // works for online-only submissions.
    }
  }, [formId, currentIdentity]);

  const drainOnce = useCallback(async () => {
    if (drainingRef.current) {
      // drain works from a snapshot taken when it starts, so a row
      // queued now would wait for some later trigger. Ask the running
      // drain to go round once more instead.
      rerunRef.current = true;
      return;
    }
    drainingRef.current = true;
    setDraining(true);
    try {
      do {
        rerunRef.current = false;
        await drain(formId, await currentIdentity(), async (row) => {
          // Upload any offline-captured attachments before posting (#280).
          // Each upload is written back to the stored row, so a retry
          // after a partial failure reuses it instead of uploading the
          // same bytes again. The row also keeps the bytes until the
          // POST succeeds (see uploadQueuedAttachments). A failure
          // throws; the outer drain marks the row failed and the queue
          // retries on the next online tick.
          const answers = await uploadQueuedAttachments(row.response, (stored) =>
            updateQueuedResponse(row.clientId, stored),
          );
          const res = await fetch(
            `/api/portal/forms/${formId}/submissions`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                clientId: row.clientId,
                schemaVersion: row.schemaVersion,
                response: answers,
                capturedAt: row.capturedAt,
                ...(typeof row.utcOffsetMinutes === 'number'
                  ? { utcOffsetMinutes: row.utcOffsetMinutes }
                  : {}),
              }),
            },
          );
          if (!res.ok) {
            throw new Error(await apiErrorMessage(res));
          }
        });
      } while (rerunRef.current);
    } finally {
      drainingRef.current = false;
      setDraining(false);
      await refreshOutbox();
    }
  }, [formId, refreshOutbox, currentIdentity]);

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
      formId,
      schemaVersion: form.schemaVersion,
      ownerUserId: await currentIdentity(),
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
                    {fmt.dateTime(r.capturedAt)}
                  </span>
                  {isAnonymousSubmission(r) ? (
                    <span
                      className="inline-flex rounded-full bg-warn/15 px-1.5 text-2xs uppercase tracking-wide text-warn"
                      title="Captured while no one was signed in. It is kept on this device and is not sent under another account."
                    >
                      held
                    </span>
                  ) : (
                    <span
                      className={`inline-flex rounded-full px-1.5 text-2xs uppercase tracking-wide ${
                        r.status === 'failed'
                          ? 'bg-warn/15 text-warn'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      {r.status}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
