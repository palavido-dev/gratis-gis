// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Housekeeping "Broken references" card (#217 companion).
 *
 * Surfaces GET /admin/housekeeping/dangling-references: live items
 * whose data references item ids that no longer resolve. The
 * failure mode is silent by nature (a map just stops drawing the
 * layer whose item vanished; nothing errors), which is exactly why
 * it needs a dashboard card instead of waiting for a human to
 * notice a hole in a map.
 *
 * Read-only on purpose: repointing a reference needs judgment
 * about the right replacement, so each row links to the item where
 * the admin fixes it (or restores the trashed target).
 */
import { useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Unlink } from 'lucide-react';
import { getItemTypeLabel } from '@/lib/item-type-icon';
import type { ItemType } from '@gratis-gis/shared-types';

export interface DanglingReferencesReport {
  referrers: Array<{
    id: string;
    type: string;
    title: string;
    missing: string[];
    trashed: string[];
  }>;
}

interface Props {
  initial: DanglingReferencesReport;
}

export function DanglingReferencesCard({ initial }: Props) {
  const [report, setReport] = useState<DanglingReferencesReport>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rescan(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        '/api/portal/admin/housekeeping/dangling-references',
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport((await res.json()) as DanglingReferencesReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Unlink className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Broken references</h2>
            <p className="text-xs text-muted">
              Items that point at other items which no longer exist
              (or sit in the trash). These render silently broken: a
              map just stops drawing that layer. Open each item to
              repoint or remove the reference.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-ink-0 hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Re-scan
        </button>
      </div>

      {error ? (
        <p className="mb-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {report.referrers.length === 0 ? (
        <p className="text-sm text-muted">
          Every reference resolves: no item points at something that
          is gone.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {report.referrers.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <Link
                href={`/items/${r.id}`}
                className="font-medium text-ink-0 hover:underline"
              >
                {r.title}
              </Link>
              <span className="text-xs text-muted">
                {getItemTypeLabel(r.type as ItemType)}
              </span>
              {r.missing.length > 0 ? (
                <span className="rounded-full border border-danger/40 bg-danger/5 px-2 py-0.5 text-2xs font-medium text-danger">
                  {r.missing.length} missing
                </span>
              ) : null}
              {r.trashed.length > 0 ? (
                <span className="rounded-full border border-warn/40 bg-warn/5 px-2 py-0.5 text-2xs font-medium text-warn">
                  {r.trashed.length} in trash
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
