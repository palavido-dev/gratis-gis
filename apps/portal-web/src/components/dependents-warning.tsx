'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Link2 } from 'lucide-react';
import {
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';

/**
 * Lightweight projection of /items/:id/dependents responses. The
 * server endpoint returns Item-shaped rows with extra fields we
 * don't need here; we lift only what the warning UI shows.
 */
export interface DependentRow {
  id: string;
  type: string;
  title: string;
}

/**
 * "Used by" warning panel rendered inside the delete confirmation
 * dialogs (#78). Fetches transitive dependents for one item id or
 * the entire bulk selection, aggregates, dedupes against the items
 * actually being trashed, and groups by type.
 *
 * Warn-but-allow: trash is reversible, so we don't block. The
 * panel just makes the side-effect explicit so the user is never
 * surprised by a map losing a layer they didn't realise it
 * referenced.
 */
export function DependentsWarning({
  itemIds,
}: {
  /** Items the user is about to soft-delete. The selection itself
   *  is excluded from the displayed list: a dependent that's also
   *  being trashed isn't a surprise. */
  itemIds: string[];
}) {
  const ids = useMemo(() => Array.from(new Set(itemIds)), [itemIds]);
  const idsKey = useMemo(() => ids.slice().sort().join(','), [ids]);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<DependentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      setLoading(false);
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Fan out one /dependents request per id. The endpoint already
    // walks the transitive graph server-side, so we just merge the
    // results client-side. Failures on individual ids are
    // non-fatal: a 404 / 403 yields an empty contribution.
    const inSelection = new Set(ids);
    Promise.all(
      ids.map((id) =>
        fetch(`/api/portal/items/${id}/dependents?transitive=true`)
          .then((r) => (r.ok ? (r.json() as Promise<DependentRow[]>) : []))
          .catch(() => [] as DependentRow[]),
      ),
    )
      .then((lists) => {
        if (cancelled) return;
        // Flatten + dedupe by id, then drop any dependent that's
        // itself in the selection (it's being trashed too, no
        // surprise to flag).
        const merged = new Map<string, DependentRow>();
        for (const list of lists) {
          for (const row of list) {
            if (inSelection.has(row.id)) continue;
            if (!merged.has(row.id)) merged.set(row.id, row);
          }
        }
        setRows(Array.from(merged.values()));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load dependents.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (loading) {
    return (
      <p className="mt-3 text-xs text-muted">Checking what depends on this...</p>
    );
  }
  if (error) {
    // Don't block on a dependents-fetch failure: the user can still
    // make the call. Show the error inline so it's obvious why the
    // panel is empty.
    return (
      <p className="mt-3 text-xs text-muted">
        Could not check dependents ({error}). Proceed with caution.
      </p>
    );
  }
  if (rows.length === 0) return null;

  // Group by type so the user can scan "two maps, one dashboard"
  // instead of an undifferentiated list. Inside each group we
  // render alphabetically so order is stable.
  const byType = new Map<string, DependentRow[]>();
  for (const r of rows) {
    const arr = byType.get(r.type) ?? [];
    arr.push(r);
    byType.set(r.type, arr);
  }
  for (const arr of byType.values()) {
    arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  // Stable group order: most-affected first, then alphabetical
  // type label for ties.
  const groups = Array.from(byType.entries()).sort((a, b) => {
    const lenDiff = b[1].length - a[1].length;
    if (lenDiff !== 0) return lenDiff;
    return getItemTypeLabel(a[0] as Parameters<typeof getItemTypeLabel>[0])
      .localeCompare(
        getItemTypeLabel(b[0] as Parameters<typeof getItemTypeLabel>[0]),
      );
  });

  // Cap the visible list so a heavily-referenced dataset doesn't
  // explode the dialog. The overflow line tells the user how many
  // more there are without forcing a scroll.
  const VISIBLE_CAP = 20;
  let visibleCount = 0;

  return (
    <div className="mt-3 rounded-md border border-amber-300/50 bg-amber-50/50 p-3">
      <div className="mb-2 flex items-start gap-2">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
        <div>
          <p className="text-xs font-semibold text-amber-900">
            {rows.length === 1
              ? '1 other item references this'
              : `${rows.length} other items reference these`}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-900/80">
            Trashing removes the reference from each of them. You can
            restore from Recently deleted if you change your mind.
          </p>
        </div>
      </div>
      <ul className="space-y-1">
        {groups.map(([type, list]) => {
          const Icon = getItemTypeIcon(
            type as Parameters<typeof getItemTypeIcon>[0],
          );
          const label = getItemTypeLabel(
            type as Parameters<typeof getItemTypeLabel>[0],
          );
          return (
            <li key={type}>
              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-900/70">
                {label} ({list.length})
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {list.map((row) => {
                  if (visibleCount >= VISIBLE_CAP) return null;
                  visibleCount += 1;
                  return (
                    <li key={row.id} className="text-xs">
                      <Link
                        href={`/items/${row.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-ink-1 hover:text-ink-0 hover:underline"
                      >
                        <Icon className="h-3 w-3 text-muted" />
                        <span className="truncate">{row.title}</span>
                        <ExternalLink className="h-2.5 w-2.5 text-muted" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      {rows.length > VISIBLE_CAP ? (
        <p className="mt-2 text-[11px] text-amber-900/80">
          +{rows.length - VISIBLE_CAP} more not shown.
        </p>
      ) : null}
    </div>
  );
}
