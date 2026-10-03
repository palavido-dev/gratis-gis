// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { FileDown } from 'lucide-react';

interface SubmissionRow {
  id: string;
  capturedAt: string;
}

/**
 * Recent submissions with a text-PDF receipt. Hidden when the
 * caller cannot list submissions (anyone who is not the owner
 * or an org admin). The Responses page remains the full browser.
 */
export function SubmissionReceipts({ formId }: { formId: string }) {
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/forms/${formId}/submissions?limit=20`);
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return;
        }
        if (!res.ok) {
          setRows([]);
          setError('Submissions could not be loaded.');
          return;
        }
        const body = (await res.json()) as SubmissionRow[];
        setRows(Array.isArray(body) ? body : []);
      } catch {
        if (!cancelled) {
          setRows([]);
          setError('Submissions could not be loaded.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId]);

  if (hidden || rows === null) return null;

  async function download(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/forms/${formId}/submissions/${id}/pdf`);
      if (!res.ok) {
        setError('The receipt could not be downloaded.');
        return;
      }
      const blob = await res.blob();
      const header = res.headers.get('content-disposition');
      const quoted = /filename="([^"]+)"/i.exec(header ?? '');
      const filename = quoted?.[1] || `submission-${id.slice(0, 8)}.pdf`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The receipt could not be downloaded.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mb-4 rounded-md border border-border bg-surface-1 px-3 py-3">
      <h2 className="text-sm font-medium text-ink-0">Receipts</h2>
      <p className="mt-1 text-2xs text-muted">
        A text PDF of each submission. The latest 20 are listed here.
      </p>
      {error ? <p className="mt-2 text-xs text-ink-0">{error}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">
          No submissions yet. Receipts appear here after someone submits the form.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3">
              <span className="text-xs text-ink-1">
                {formatWhen(row.capturedAt)}
              </span>
              <button
                type="button"
                onClick={() => void download(row.id)}
                disabled={busyId === row.id}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 hover:bg-surface-2 disabled:opacity-50"
              >
                <FileDown className="h-3.5 w-3.5" />
                {busyId === row.id ? 'Preparing…' : 'Download PDF'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
