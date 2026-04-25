'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Folder as FolderIcon,
  Search,
} from 'lucide-react';
import type { ItemAccess } from '@gratis-gis/shared-types';

export interface AdminFolderRow {
  id: string;
  title: string;
  breadcrumb: string;
  ownerId: string;
  ownerLabel: string;
  access: ItemAccess;
  childCount: number;
  updatedAt: string;
}

interface Props {
  rows: AdminFolderRow[];
}

type SortBy = 'breadcrumb' | 'owner' | 'children' | 'updated';
type SortDir = 'asc' | 'desc';

const ACCESS_BADGE: Record<ItemAccess, string> = {
  private: 'bg-slate-100 text-slate-700',
  org: 'bg-sky-100 text-sky-700',
  public: 'bg-emerald-100 text-emerald-700',
};

/**
 * Admin folders table. Sortable columns (breadcrumb, owner, child
 * count, updated) plus a free-text filter that matches the
 * breadcrumb path so an admin searching "surveys" finds both
 * "Project A > Surveys" and "Project B > Surveys" without ambiguity.
 *
 * Each row links to the folder detail page so an admin can take
 * action through the same surface a regular author would use --
 * there is no admin-only edit flow on top of the existing item
 * editor.
 */
export function AdminFoldersView({ rows }: Props) {
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('breadcrumb');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let filtered = rows;
    if (needle) {
      filtered = filtered.filter(
        (r) =>
          r.breadcrumb.toLowerCase().includes(needle) ||
          r.ownerLabel.toLowerCase().includes(needle),
      );
    }
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'breadcrumb') {
        cmp = a.breadcrumb.localeCompare(b.breadcrumb);
      } else if (sortBy === 'owner') {
        cmp = a.ownerLabel.localeCompare(b.ownerLabel);
      } else if (sortBy === 'children') {
        cmp = a.childCount - b.childCount;
      } else {
        cmp =
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [rows, q, sortBy, sortDir]);

  function toggleSort(next: SortBy) {
    if (sortBy === next) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(next);
      setSortDir('asc');
    }
  }

  return (
    <div className="space-y-3">
      <label className="relative block max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name, breadcrumb, or owner"
          className="h-9 w-full rounded-md border border-border bg-surface-1 pl-8 pr-2 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      </label>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-1 px-6 py-10 text-center text-sm text-muted">
          {rows.length === 0
            ? 'No folders in this org yet.'
            : 'No folders match your filter.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
              <tr>
                <SortHead
                  label="Breadcrumb"
                  active={sortBy === 'breadcrumb'}
                  dir={sortDir}
                  onClick={() => toggleSort('breadcrumb')}
                />
                <SortHead
                  label="Owner"
                  active={sortBy === 'owner'}
                  dir={sortDir}
                  onClick={() => toggleSort('owner')}
                />
                <th className="px-3 py-2 text-left font-medium">Access</th>
                <SortHead
                  label="Items"
                  active={sortBy === 'children'}
                  dir={sortDir}
                  onClick={() => toggleSort('children')}
                />
                <SortHead
                  label="Updated"
                  active={sortBy === 'updated'}
                  dir={sortDir}
                  onClick={() => toggleSort('updated')}
                />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-border hover:bg-surface-2"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/items/${row.id}`}
                      className="inline-flex items-center gap-1.5 text-ink-1 hover:text-accent"
                    >
                      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                      <span className="truncate">{row.breadcrumb}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-ink-1">{row.ownerLabel}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${ACCESS_BADGE[row.access]}`}
                    >
                      {row.access}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-1 tabular-nums">
                    {row.childCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {new Date(row.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortHead({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className="cursor-pointer px-3 py-2 text-left font-medium hover:text-ink-1"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 text-muted/50" />
        )}
      </span>
    </th>
  );
}