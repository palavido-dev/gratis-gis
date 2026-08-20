// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Housekeeping "Broken references" card (#217 companion).
 *
 * Surfaces GET /admin/housekeeping/dangling-references: references to
 * item ids that no longer resolve. The failure mode is silent by
 * nature (a map just stops drawing the layer whose item vanished; the
 * landing page just skips a featured pin), which is exactly why it
 * needs a dashboard card instead of waiting for a human to notice a
 * hole in a map.
 *
 * Rows come in two scopes. 'item' means the reference lives in an
 * item's own configuration; 'settings' means it lives outside the
 * item table (the landing-page featured list, a share's geo limit),
 * where `type` is already a label and the fix lives somewhere the row
 * id does not point at. Follow `href` rather than deriving a link.
 *
 * Read-only on purpose: repointing a reference needs judgment about
 * the right replacement, so each row links to where the admin fixes
 * it (or restores the trashed target).
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
    scope: 'item' | 'settings';
    href: string;
    note?: string;
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
              Things that point at items which no longer exist (or sit
              in the trash), whether the pointer lives in an item or in
              your portal settings. These break silently: a map just
              stops drawing that layer, the landing page just skips
              that featured item. Open each one to repoint or remove
              the reference.
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
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  href={r.href}
                  className="font-medium text-ink-0 hover:underline"
                >
                  {r.title}
                </Link>
                <span className="text-xs text-muted">
                  {/* Settings rows have no item type to resolve; their
                      `type` is already the label to print. */}
                  {r.scope === 'settings'
                    ? r.type
                    : getItemTypeLabel(r.type as ItemType)}
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
              </div>
              {r.note ? (
                <p className="mt-0.5 text-xs text-muted">{r.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
