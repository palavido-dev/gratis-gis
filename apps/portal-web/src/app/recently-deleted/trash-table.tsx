// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, Trash2 } from 'lucide-react';
import type { Group, Item } from '@gratis-gis/shared-types';
import { getItemDisplayLabel } from '@/lib/item-type-icon';
import { ConfirmDialog } from '@/components/confirm-dialog';

/**
 * Recently-deleted bulk table (#360). Single client component that
 * owns selection state, the bulk action bar, and the per-row
 * restore / delete-forever buttons. Replaces the previous
 * ItemRow + GroupRow split so selection state can be shared across
 * all rows on the page without prop-drilling through a server
 * component.
 *
 * The typed-name confirmation that used to gate per-row Delete
 * forever is gone: items in the trash are already deleted, this
 * page IS the safety net, and a typed-name gate per row was
 * actively annoying when sweeping out dozens of test items.
 * Restore + Delete forever both still confirm via a single Yes/No
 * dialog so a stray click can't nuke an item without intent.
 *
 * Generic over Item | Group so the same component drives both tabs;
 * the kind prop maps to the right API endpoints and copy.
 */
type Kind = 'items' | 'groups';

type TrashRow = {
  id: string;
  title: string;
  subtitle: string | null;
  deletedAt: Date | null;
};

interface Props {
  kind: Kind;
  records: Item[] | Group[];
  /** Retention window in days, used in the auto-purge countdown. */
  retentionDays: number;
}

export function TrashTable({ kind, records, retentionDays }: Props) {
  const router = useRouter();
  const rows = useMemo<TrashRow[]>(
    () =>
      records.map((r) => {
        if (kind === 'items') {
          const it = r as Item;
          return {
            id: it.id,
            title: it.title,
            // The raw ItemType leaked here as "data_layer" and
            // "data_collection" while every other surface shows the
            // friendly label. Easy to miss because `subtitle` is
            // generic: for groups it carries a description, so this
            // has to be fixed in the items branch only.
            subtitle: getItemDisplayLabel(it),
            deletedAt: it.deletedAt ? new Date(it.deletedAt) : null,
          };
        }
        const g = r as Group;
        return {
          id: g.id,
          title: g.title,
          subtitle: g.description ?? null,
          deletedAt: g.deletedAt ? new Date(g.deletedAt) : null,
        };
      }),
    [kind, records],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<
    | null
    | { kind: 'restore' | 'purge'; ids: Set<string> }
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<
    | null
    | { op: 'purge-one'; row: TrashRow }
    | { op: 'purge-many'; ids: string[] }
  >(null);

  const allSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0 && !allSelected;
  const anyPending = pending !== null;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Endpoint shapes. Both POST/DELETE flows are idempotent on the
  // server, so a Promise.all that loses one to a 409 won't poison
  // the rest. We collect failures and surface a single error string
  // rather than partial-state aborting -- the user's mental model is
  // "the ones that came back stayed; try the rest again."
  function pathForRestore(id: string) {
    return kind === 'items'
      ? `/api/portal/items/${id}/restore`
      : `/api/portal/groups/${id}/restore`;
  }
  function pathForPurge(id: string) {
    return kind === 'items'
      ? `/api/portal/items/${id}/purge`
      : `/api/portal/groups/${id}/purge`;
  }

  async function runOne(id: string, op: 'restore' | 'purge'): Promise<string | null> {
    const url = op === 'restore' ? pathForRestore(id) : pathForPurge(id);
    const method = op === 'restore' ? 'POST' : 'DELETE';
    try {
      const res = await fetch(url, { method });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return `${res.status}${txt ? `: ${txt}` : ''}`;
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function runMany(ids: string[], op: 'restore' | 'purge') {
    setError(null);
    const idSet = new Set(ids);
    setPending({ kind: op, ids: idSet });
    try {
      const results = await Promise.all(
        ids.map(async (id) => ({ id, err: await runOne(id, op) })),
      );
      const failures = results.filter((r) => r.err !== null);
      if (failures.length > 0) {
        const head = failures.slice(0, 3).map((f) => f.err).join('; ');
        const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : '';
        setError(
          `${failures.length} of ${ids.length} ${op === 'restore' ? 'restores' : 'deletes'} failed: ${head}${more}`,
        );
      }
      // Drop everything that succeeded from the selection so the
      // next bulk action only retries the failures.
      setSelected((cur) => {
        const next = new Set(cur);
        for (const r of results) if (r.err === null) next.delete(r.id);
        return next;
      });
      router.refresh();
    } finally {
      setPending(null);
      setConfirmKind(null);
    }
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 shadow-card">
          <p className="text-xs text-ink-1">
            <span className="font-semibold">{selected.size}</span> selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runMany(Array.from(selected), 'restore')}
              disabled={anyPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
            >
              {pending?.kind === 'restore' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Restore selected
            </button>
            <button
              type="button"
              onClick={() =>
                setConfirmKind({ op: 'purge-many', ids: Array.from(selected) })
              }
              disabled={anyPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/40 bg-danger/5 px-2.5 text-xs font-medium text-danger shadow-card hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete forever
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-surface-2 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="w-9 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded border-border text-accent focus:ring-1 focus:ring-accent"
                />
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                {kind === 'items' ? 'Item' : 'Group'}
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Deleted
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Auto-purge
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const purgeAt =
                r.deletedAt !== null
                  ? new Date(
                      r.deletedAt.getTime() +
                        retentionDays * 24 * 60 * 60 * 1000,
                    )
                  : null;
              const daysLeft =
                purgeAt !== null
                  ? Math.max(
                      0,
                      Math.ceil(
                        (purgeAt.getTime() - Date.now()) /
                          (24 * 60 * 60 * 1000),
                      ),
                    )
                  : null;
              const isSelected = selected.has(r.id);
              const isPending =
                pending !== null && pending.ids.has(r.id);
              return (
                <tr
                  key={r.id}
                  className={`border-b border-border last:border-0 ${
                    isSelected ? 'bg-accent/5' : ''
                  }`}
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.title}`}
                      checked={isSelected}
                      onChange={() => toggleOne(r.id)}
                      className="h-4 w-4 cursor-pointer rounded border-border text-accent focus:ring-1 focus:ring-accent"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-0">{r.title}</div>
                    {r.subtitle ? (
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {r.subtitle}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {r.deletedAt ? r.deletedAt.toLocaleString() : ''}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {daysLeft !== null ? (
                      <span>
                        {daysLeft} day{daysLeft === 1 ? '' : 's'} left
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => runMany([r.id], 'restore')}
                        disabled={anyPending}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
                      >
                        {isPending && pending?.kind === 'restore' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmKind({ op: 'purge-one', row: r })}
                        disabled={anyPending}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-danger shadow-card hover:bg-danger/5 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete forever
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmKind !== null}
        onCancel={() => setConfirmKind(null)}
        onConfirm={() => {
          if (confirmKind?.op === 'purge-one') {
            void runMany([confirmKind.row.id], 'purge');
          } else if (confirmKind?.op === 'purge-many') {
            void runMany(confirmKind.ids, 'purge');
          }
        }}
        title={
          confirmKind?.op === 'purge-many'
            ? `Permanently delete ${confirmKind.ids.length} ${
                confirmKind.ids.length === 1
                  ? kind === 'items'
                    ? 'item'
                    : 'group'
                  : kind
              }?`
            : confirmKind?.op === 'purge-one'
              ? `Permanently delete "${confirmKind.row.title}"?`
              : ''
        }
        description={
          kind === 'items'
            ? 'These items and every share attached to them will be removed. For data layers this also drops the underlying tables. This cannot be undone.'
            : 'These groups, their memberships, and every share that targeted them will be removed. This cannot be undone.'
        }
        confirmLabel="Delete forever"
      />
    </div>
  );
}
