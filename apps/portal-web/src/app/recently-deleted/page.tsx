// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import type { Group, Item } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { TrashTable } from './trash-table';

// Retention window shown when /users/me does not say (an older API).
// The purge job reads RECYCLE_BIN_RETENTION_DAYS and /users/me reports
// the same value as trashRetentionDays.
const DEFAULT_RETENTION_DAYS = 30;

// Deleted items shown per page. An admin's trash holds the whole org's
// deletions, so it is read a page at a time.
const TRASH_PAGE_SIZE = 100;

// Explicit kind union. Future kinds (users, reports) slot in here.
type Kind = 'items' | 'groups';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'items', label: 'Items' },
  { value: 'groups', label: 'Groups' },
];

interface Props {
  searchParams: Promise<{ kind?: string; page?: string }>;
}

export const metadata = { title: 'Recently deleted' };

export default async function RecentlyDeletedPage(props: Props) {
  const searchParams = await props.searchParams;
  // Normalize the query param to a known kind; unknown values fall back
  // to items so a stale bookmark never 500s.
  const kind: Kind =
    searchParams.kind === 'groups' ? 'groups' : 'items';
  // 0-based page of the items tab. Groups are few and stay unpaged.
  const parsedPage = Number.parseInt(searchParams.page ?? '', 10);
  const page =
    kind === 'items' && Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 0;

  // Fetch only the kind the user is looking at. Keeps latency predictable
  // and avoids fetching content the user might not have permission to see
  // (trash is scoped per-kind on the backend).
  // One row past the page says whether there is a next page.
  const [itemsPlusOne, groups] =
    kind === 'items'
      ? [
          await apiFetch<Item[]>(
            `/api/items/trash?limit=${TRASH_PAGE_SIZE + 1}&offset=${page * TRASH_PAGE_SIZE}`,
          ),
          [] as Group[],
        ]
      : [[] as Item[], await apiFetch<Group[]>('/api/groups/trash')];
  const hasNext = itemsPlusOne.length > TRASH_PAGE_SIZE;
  const items = hasNext ? itemsPlusOne.slice(0, TRASH_PAGE_SIZE) : itemsPlusOne;

  const activeList = kind === 'items' ? items : groups;
  const me = await apiFetch<{ trashRetentionDays?: number }>('/api/users/me').catch(
    () => null,
  );
  const retentionDays = me?.trashRetentionDays ?? DEFAULT_RETENTION_DAYS;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6">
        <p className="text-sm text-muted">Safety net</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Recently deleted
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Content you delete lives here for {retentionDays} days so you can
          bring it back if you change your mind. After that it is
          permanently removed.
        </p>
      </header>

      <nav
        aria-label="Recently deleted categories"
        className="mb-6 flex gap-1 border-b border-border"
      >
        {KINDS.map((k) => {
          const active = k.value === kind;
          return (
            <Link
              key={k.value}
              href={`/recently-deleted?kind=${k.value}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'relative -mb-px border-b-2 border-accent px-3 py-2 text-sm font-medium text-ink-0'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink-1'
              }
            >
              {k.label}
            </Link>
          );
        })}
      </nav>

      {activeList.length === 0 && page === 0 ? (
        <EmptyState
          icon={<Trash2 className="h-5 w-5" />}
          title={
            kind === 'items'
              ? 'No items to recover'
              : 'No groups to recover'
          }
          description={`Deleted ${kind} will appear here for ${retentionDays} days before permanent removal.`}
        />
      ) : (
        <TrashTable
          // A new page starts with nothing selected, so a bulk action
          // never reaches rows the user can no longer see.
          key={`${kind}-${page}`}
          kind={kind}
          records={kind === 'items' ? items : groups}
          retentionDays={retentionDays}
        />
      )}

      {page > 0 || hasNext ? (
        <nav
          aria-label="Recently deleted pages"
          className="mt-4 flex items-center justify-between text-sm"
        >
          {page > 0 ? (
            <Link
              href={`/recently-deleted?kind=items&page=${page - 1}`}
              className="text-accent hover:underline"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted">
            {activeList.length > 0
              ? `${page * TRASH_PAGE_SIZE + 1} to ${page * TRASH_PAGE_SIZE + activeList.length}`
              : 'Nothing left on this page'}
          </span>
          {hasNext ? (
            <Link
              href={`/recently-deleted?kind=items&page=${page + 1}`}
              className="text-accent hover:underline"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
