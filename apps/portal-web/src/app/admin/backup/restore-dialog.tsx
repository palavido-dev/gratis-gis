'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  X,
} from 'lucide-react';

/**
 * Confirmation dialog for the destructive restore flow. Two gates:
 *
 *   1. An archive preview fetched server-side the moment we open, so
 *      the admin sees what they're about to restore (filename,
 *      archive age, object count) rather than a naked "are you
 *      sure".
 *   2. A type-to-confirm input. The admin has to type the portal's
 *      org slug verbatim; anything else and the button stays
 *      disabled. Matches GitHub's delete-repo pattern.
 *
 * The dialog blocks the page while the restore runs so the admin
 * can't wander off and trigger a second one. When the restore
 * finishes (success or fail), we show the result for a beat and
 * reload the page.
 */
interface Preview {
  runId: string;
  filename: string;
  sizeBytes: number;
  manifest: {
    version: number;
    createdAt: string;
    trigger: string;
    databases: string[];
    minio: { bucket: string; objectCount: number; totalBytes: number };
    portalVersion?: string | null;
    gitSha?: string | null;
  };
}

interface Props {
  runId: string;
  filename: string;
  /** Plain-language portal name the admin must type to confirm. */
  orgName: string;
  onClose: () => void;
}

export function RestoreDialog({ runId, filename, orgName, onClose }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<'success' | 'failed' | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/portal/admin/backup/runs/${runId}/restore/preview`,
        );
        if (!res.ok) {
          setLoadErr(`Could not preview archive (HTTP ${res.status}).`);
          return;
        }
        const body = (await res.json()) as Preview;
        if (!cancelled) setPreview(body);
      } catch (e) {
        if (!cancelled)
          setLoadErr(e instanceof Error ? e.message : 'Preview failed.');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Case-insensitive, whitespace-trimmed match so an admin typing
  // "Acme Corp" vs "acme corp" doesn't get bounced by a capitalisation
  // mismatch. The wire-level check on the server mirrors this.
  const canRestore =
    !restoring &&
    !result &&
    confirmText.trim().toLowerCase() === orgName.trim().toLowerCase();

  async function handleRestore() {
    setRestoring(true);
    setResultMsg(null);
    try {
      const res = await fetch(
        `/api/portal/admin/backup/runs/${runId}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmName: confirmText.trim() }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string }).message ?? `HTTP ${res.status}`;
        setResult('failed');
        setResultMsg(msg);
        return;
      }
      setResult('success');
      // Give the admin a beat to read the success message, then
      // reload so the restored state is visible.
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      setResult('failed');
      setResultMsg(e instanceof Error ? e.message : 'Restore failed.');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-danger/30 bg-surface-1 p-5 shadow-raised">
        <header className="flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-danger" />
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-ink-0">
              Restore from backup
            </h2>
            <p className="text-xs text-muted">
              This replaces all of the portal's items, files, and
              settings with the contents of the backup you chose.
              Anything you've changed since that backup was taken
              will be lost.
            </p>
          </div>
          {!restoring && !result ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-0 text-muted hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </header>

        {loadErr ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            {loadErr}
          </div>
        ) : !preview ? (
          <p className="inline-flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the archive's manifest…
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border bg-surface-0 p-3 text-xs">
            <dt className="text-muted">File</dt>
            <dd className="truncate font-mono text-ink-0" title={filename}>
              {preview.filename}
            </dd>
            <dt className="text-muted">Created</dt>
            <dd className="text-ink-0">
              {new Date(preview.manifest.createdAt).toLocaleString()}
            </dd>
            <dt className="text-muted">Trigger</dt>
            <dd className="text-ink-0">{preview.manifest.trigger}</dd>
            <dt className="text-muted">Archive size</dt>
            <dd className="text-ink-0">{formatBytes(preview.sizeBytes)}</dd>
            <dt className="text-muted">Objects in backup</dt>
            <dd className="text-ink-0">
              {preview.manifest.minio.objectCount.toLocaleString()}
            </dd>
            {preview.manifest.portalVersion ? (
              <>
                <dt className="text-muted">Portal version</dt>
                <dd className="font-mono text-ink-0">
                  {preview.manifest.portalVersion}
                </dd>
              </>
            ) : null}
          </dl>
        )}

        <div className="space-y-1">
          <p className="text-xs text-ink-0">
            To continue, type this portal's name{' '}
            <strong className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">
              {orgName}
            </strong>{' '}
            below. We ask for this so you can't accidentally restore
            the wrong backup onto the wrong portal.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={restoring || !!result}
            autoFocus
            className={`w-full rounded border px-2 py-1.5 text-sm ${
              confirmText &&
              confirmText.trim().toLowerCase() !== orgName.trim().toLowerCase()
                ? 'border-amber-400 bg-amber-50'
                : 'border-border bg-surface-0'
            }`}
            placeholder={orgName}
          />
        </div>

        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          While the restore is running, the portal will be temporarily
          unavailable to everyone: other people will see a
          "maintenance mode" message for a minute or two. Ask your
          team to stop editing before you click below, because any
          changes in progress right now will be overwritten.
        </p>

        {result === 'failed' ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            Restore failed: {resultMsg}
          </div>
        ) : null}
        {result === 'success' ? (
          <div className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
            Restore succeeded. Reloading the page…
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={restoring}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!canRestore}
            className="inline-flex items-center gap-2 rounded-md border border-danger bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restoring ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldAlert className="h-4 w-4" />
            )}
            {restoring ? 'Restoring…' : 'Overwrite everything'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
