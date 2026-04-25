import Link from 'next/link';
import { Plus, Layers, ChevronRight, Folder as FolderIcon } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ItemsView } from './items-view';
import { FolderRail, type FolderRailNode } from './folder-rail';

interface Props {
  searchParams: {
    scope?: string;
    mine?: string;
    q?: string;
    folder?: string;
  };
}

/**
 * Items page: single entry point for all content + folder navigation.
 *
 * Scope toggle: ?scope=mine (default) vs ?scope=all. Folder selection
 * is in the URL too via ?folder=<uuid>; clicking a folder in the rail
 * tree sets that param and the grid swaps to "what's in that folder"
 * without leaving the page. Breadcrumbs above the grid show the path
 * and the user clicks "All items" to clear.
 *
 * Backward compat: the old `?mine=true` URL still works (matches a
 * handful of external links + the sidebar nav that used to link
 * straight to it).
 */
export default async function ItemsPage({ searchParams }: Props) {
  const scope: 'mine' | 'all' =
    searchParams.scope === 'all'
      ? 'all'
      : searchParams.scope === 'mine'
        ? 'mine'
        : searchParams.mine === 'true'
          ? 'mine'
          : searchParams.mine === 'false'
            ? 'all'
            : 'mine';

  const folderId = searchParams.folder ?? null;

  // Pull every folder the caller can see in this org so the rail
  // tree can render top-level eagerly. Failure is non-fatal -- the
  // rail simply renders empty.
  const folders = await apiFetch<ItemWithShares[]>('/api/items?type=folder')
    .then((rows) =>
      rows.map<FolderRailNode>((r) => ({
        id: r.id,
        title: r.title,
        childItemIds: Array.isArray(
          (r.data as { childItemIds?: unknown } | null)?.childItemIds,
        )
          ? ((r.data as { childItemIds: unknown[] }).childItemIds.filter(
              (x): x is string => typeof x === 'string',
            ))
          : [],
      })),
    )
    .catch(() => []);

  // Items list. Two modes:
  //   - With ?folder=<id>: fetch the folder's contents (visible to
  //     this caller, in the folder's authoritative order). The
  //     scope toggle (mine/all) and any client-side type filters
  //     still apply on top.
  //   - Without folder: fetch the user's items list with the regular
  //     scope toggle in effect.
  let items: ItemWithShares[] = [];
  let activeFolder: ItemWithShares | null = null;
  if (folderId) {
    try {
      const [folder, contents] = await Promise.all([
        apiFetch<ItemWithShares>(`/api/items/${folderId}`),
        apiFetch<ItemWithShares[]>(
          `/api/items/${folderId}/folder-contents`,
        ),
      ]);
      activeFolder = folder.type === 'folder' ? folder : null;
      items = contents;
    } catch {
      items = [];
      activeFolder = null;
    }
  } else {
    const qs = new URLSearchParams();
    if (scope === 'mine') qs.set('mine', 'true');
    if (searchParams.q) qs.set('q', searchParams.q);
    items = await apiFetch<ItemWithShares[]>(
      `/api/items${qs.toString() ? `?${qs}` : ''}`,
    );
  }

  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');

  // Breadcrumbs from the visible folder set: walks the parent chain
  // back to a top-level ancestor. Multi-parent folders pick the
  // first parent encountered, matching the rail's behaviour.
  const breadcrumb: Array<{ id: string; title: string }> = [];
  if (activeFolder && folders.length > 0) {
    const byId = new Map<string, FolderRailNode>();
    for (const f of folders) byId.set(f.id, f);
    const parentOf = new Map<string, string>();
    for (const f of folders) {
      for (const c of f.childItemIds) {
        if (!parentOf.has(c)) parentOf.set(c, f.id);
      }
    }
    const seen = new Set<string>();
    let cur: string | undefined = activeFolder.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = byId.get(cur);
      if (!row) break;
      breadcrumb.unshift({ id: row.id, title: row.title });
      cur = parentOf.get(cur);
    }
  }

  const isMine = scope === 'mine';

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-10">
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

      {/* Scope toggle disappears when a folder is selected: a folder
          shows its own contents intersected with what the caller can
          see, and the mine/all distinction stops being meaningful. */}
      {!folderId ? (
        <div className="mb-4 inline-flex rounded-md border border-border bg-surface-1 p-0.5 text-sm">
          <ScopeTab href={buildHref(searchParams, 'mine')} active={isMine}>
            My items
          </ScopeTab>
          <ScopeTab href={buildHref(searchParams, 'all')} active={!isMine}>
            All items
          </ScopeTab>
        </div>
      ) : null}

      <div className="flex flex-col gap-6 md:flex-row">
        <FolderRail
          folders={folders}
          activeFolderId={folderId ?? undefined}
        />
        <div className="flex-1 min-w-0">
          {activeFolder ? (
            <nav
              aria-label="Folder breadcrumb"
              className="mb-3 flex flex-wrap items-center gap-1 text-sm"
            >
              <Link
                href="/items"
                className="text-muted hover:text-ink-1 hover:underline"
              >
                All items
              </Link>
              {breadcrumb.map((hop, idx) => {
                const isLast = idx === breadcrumb.length - 1;
                return (
                  <span
                    key={hop.id}
                    className="inline-flex items-center gap-1"
                  >
                    <ChevronRight className="h-3.5 w-3.5 text-muted/60" />
                    <FolderIcon className="h-3.5 w-3.5 text-amber-700" />
                    {isLast ? (
                      <span className="font-medium text-ink-1">
                        {hop.title}
                      </span>
                    ) : (
                      <Link
                        href={`/items?folder=${hop.id}`}
                        className="text-muted hover:text-ink-1 hover:underline"
                      >
                        {hop.title}
                      </Link>
                    )}
                  </span>
                );
              })}
              <span className="ml-2 text-xs text-muted">
                <Link
                  href={`/items/${activeFolder.id}`}
                  className="hover:text-ink-1 hover:underline"
                >
                  Folder details →
                </Link>
              </span>
            </nav>
          ) : null}
          {items.length === 0 ? (
            <EmptyState
              icon={<Layers className="h-5 w-5" />}
              title={
                activeFolder
                  ? `${activeFolder.title} is empty`
                  : isMine
                    ? 'No items yet'
                    : 'Nothing shared with you yet'
              }
              description={
                activeFolder
                  ? 'Use "Add items" on the folder details page or drag items here from the all-items view.'
                  : isMine
                    ? 'Create your first web map, form, or feature service to get started.'
                    : 'When a teammate shares content with you or your group, it will show up here.'
              }
              action={
                isMine && !activeFolder ? (
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
            <ItemsView
              items={items}
              currentUser={me}
              folders={folders}
            />
          )}
        </div>
      </div>
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