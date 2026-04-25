import Link from 'next/link';
import { Plus, Layers } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ItemsView } from './items-view';

interface Props {
  searchParams: { scope?: string; mine?: string; q?: string };
}

/**
 * Items page: single entry point for all content.
 *
 * Scope toggle: ?scope=mine (default) vs ?scope=all. We deliberately
 * default to 'mine' so a user's own content leads the page; one click
 * of the toggle expands to the full org view they have access to.
 *
 * Backward compat: the old `?mine=true` URL still works (matches a
 * handful of external links + the sidebar nav that used to link
 * straight to it).
 */
export default async function ItemsPage({ searchParams }: Props) {
  // Normalize scope. Accept the legacy `?mine=true` URL so existing
  // links / bookmarks keep working.
  const scope: 'mine' | 'all' =
    searchParams.scope === 'all'
      ? 'all'
      : searchParams.scope === 'mine'
        ? 'mine'
        : searchParams.mine === 'true'
          ? 'mine'
          : searchParams.mine === 'false'
            ? 'all'
            : 'mine'; // default

  const qs = new URLSearchParams();
  if (scope === 'mine') qs.set('mine', 'true');
  if (searchParams.q) qs.set('q', searchParams.q);

  // Items come back with their shares joined so the sharing indicator
  // on each card has the data it needs without a second round-trip.
  const items = await apiFetch<ItemWithShares[]>(
    `/api/items${qs.toString() ? `?${qs}` : ''}`,
  );
  // Viewer is fetched once; all per-card canManage checks run off it.
  const me = await apiFetch<{ id: string; orgRole: string }>(
    '/api/users/me',
  );
  const isMine = scope === 'mine';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Items</h1>
        </div>

        <Link
          href="/items/new"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New item
        </Link>
      </header>

      {/* Scope toggle sits above the view/group/filter bar so it reads
          as the primary slice of the list. Server-rendered so the
          correct tab is active on first paint with no flicker; the
          links carry the user's other query params along if we ever
          add more (q, etc.). */}
      <div className="mb-4 inline-flex rounded-md border border-border bg-surface-1 p-0.5 text-sm">
        <ScopeTab href={buildHref(searchParams, 'mine')} active={isMine}>
          My items
        </ScopeTab>
        <ScopeTab href={buildHref(searchParams, 'all')} active={!isMine}>
          All items
        </ScopeTab>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-5 w-5" />}
          title={isMine ? 'No items yet' : 'Nothing shared with you yet'}
          description={
            isMine
              ? 'Create your first web map, form, or feature service to get started.'
              : 'When a teammate shares content with you or your group, it will show up here.'
          }
          action={
            isMine ? (
              <Link
                href="/items/new"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                Create an item
              </Link>
            ) : null
          }
        />
      ) : (
        <ItemsView items={items} currentUser={me} />
      )}
    </div>
  );
}

/**
 * Preserve any non-scope query params (search text, etc.) while
 * flipping to the given scope. Keeps deep-linkable URLs clean.
 */
function buildHref(
  current: { scope?: string; mine?: string; q?: string },
  scope: 'mine' | 'all',
): string {
  const qs = new URLSearchParams();
  qs.set('scope', scope);
  if (current.q) qs.set('q', current.q);
  return `/items?${qs.toString()}`;
}

function ScopeTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1 font-medium transition-colors ${
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted hover:bg-surface-2 hover:text-ink-1'
      }`}
    >
      {children}
    </Link>
  );
}
