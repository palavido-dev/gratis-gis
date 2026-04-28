'use client';

import { useCallback, useEffect, useState } from 'react';
import { CloudOff, RefreshCcw, Wifi } from 'lucide-react';
import type { FormSchema, Response } from '@gratis-gis/form-schema';
import { FormRuntime } from '@/components/form-runtime';
import {
  drain,
  listQueued,
  queueSubmission,
  type QueuedSubmission,
} from '@/lib/form-offline';

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

  const refreshOutbox = useCallback(async () => {
    try {
      const all = await listQueued();
      setOutbox(all.filter((r) => r.formId === form.id && r.status !== 'sent'));
    } catch {
      // IndexedDB unavailable (private browsing, etc) -- runtime still
      // works for online-only submissions.
    }
  }, [form.id]);

  const drainOnce = useCallback(async () => {
    if (draining) return;
    setDraining(true);
    try {
      await drain(form.id, async (row) => {
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
      setDraining(false);
      await refreshOutbox();
    }
  }, [draining, form.id, refreshOutbox]);

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
              online ? 'text-emerald-700' : 'text-amber-700'
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
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
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
                    className={`inline-flex rounded-full px-1.5 text-[10px] uppercase tracking-wide ${
                      r.status === 'failed'
                        ? 'bg-amber-100 text-amber-900'
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
