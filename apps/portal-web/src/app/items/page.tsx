// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Plus, Layers, ChevronRight, Folder as FolderIcon } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ItemsView } from './items-view';
import { type FolderRailNode } from './folder-rail';
import { FoldersDrawer } from './folders-drawer';
import { WelcomePanel } from './welcome-panel';
import { getServerLocale } from '@/lib/i18n/server';
import { t } from '@/lib/i18n';

interface Props {
  searchParams: Promise<{
    scope?: string;
    mine?: string;
    q?: string;
    folder?: string;
  }>;
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
export default async function ItemsPage(props: Props) {
  const locale = await getServerLocale();
  const searchParams = await props.searchParams;
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

  // Need `me` early so the rail's per-row canEdit flag (owner or
  // org admin) can be computed when shaping the FolderRailNode set.
  const meEarly = await apiFetch<{ id: string; orgRole: string }>(
    '/api/users/me',
  );
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
        canEdit:
          r.ownerId === meEarly.id || meEarly.orgRole === 'admin',
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

  const me = meEarly;

  // #80: geo_boundary items are needed by the bulk-share modal so
  // an admin flipping items to Org or Public can also pick a tier-
  // level clip boundary. Same fetch the item-detail SharingPanel
  // uses; cached per-render. Failure is non-fatal -- the picker
  // just renders an empty list with a hint.
  const geoBoundaries = await apiFetch<
    Array<{ id: string; title: string }>
  >('/api/items?type=geo_boundary&lite=true').catch(
    () => [] as Array<{ id: string; title: string }>,
  );

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
          <p className="text-sm text-muted">{t('itemsPage.eyebrow', undefined, locale)}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t('nav.items', undefined, locale)}</h1>
        </div>

        <Link
          href="/items/new"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('itemsPage.newItem', undefined, locale)}
        </Link>
      </header>
      {/* Scope toggle disappears when a folder is selected: a folder
          shows its own contents intersected with what the caller can
          see, and the mine/all distinction stops being meaningful. */}
      {!folderId ? (
        <div className="mb-4 inline-flex rounded-md border border-border bg-surface-1 p-0.5 text-sm">
          <ScopeTab href={buildHref(searchParams, 'mine')} active={isMine}>
            {t('itemsPage.myItems', undefined, locale)}
          </ScopeTab>
          <ScopeTab href={buildHref(searchParams, 'all')} active={!isMine}>
            {t('itemsPage.allItems', undefined, locale)}
          </ScopeTab>
        </div>
      ) : null}
      <FoldersDrawer
        folders={folders}
        {...(folderId ? { activeFolderId: folderId } : {})}
      >
        <>
          {activeFolder ? (
            <nav
              aria-label={t('itemsPage.folderBreadcrumb', undefined, locale)}
              className="mb-3 flex flex-wrap items-center gap-1 text-sm"
            >
              <Link
                href="/items"
                className="text-muted hover:text-ink-1 hover:underline"
              >
                {t('itemsPage.allItems', undefined, locale)}
              </Link>
              {breadcrumb.map((hop, idx) => {
                const isLast = idx === breadcrumb.length - 1;
                return (
                  <span
                    key={hop.id}
                    className="inline-flex items-center gap-1"
                  >
                    <ChevronRight className="h-3.5 w-3.5 text-muted/60" />
                    <FolderIcon className="h-3.5 w-3.5 text-warn" />
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
                  {t('itemsPage.folderDetails', undefined, locale)}
                </Link>
              </span>
            </nav>
          ) : null}
          {items.length === 0 ? (
            // A non-empty search that returns zero rows wins the
            // copy decision: "no items yet" / "nothing shared with
            // you yet" reads as "you have no content" which is
            // wrong (and confusing) when the user just typed
            // "boggedy boggedy" into the search box.
            (searchParams.q && searchParams.q.trim().length > 0 ? (<EmptyState
              icon={<Layers className="h-5 w-5" />}
              title={t('itemsPage.emptySearchTitle', undefined, locale)}
              description={t('itemsPage.emptySearchDescription', {
                scope: activeFolder
                  ? `"${activeFolder.title}"`
                  : isMine
                    ? t('itemsPage.scopeYourItems', undefined, locale)
                    : t('itemsPage.scopeSharedWithYou', undefined, locale),
                query: searchParams.q,
              }, locale)}
            />) : isMine && !activeFolder && me.orgRole !== 'viewer' ? (
              // #147 Phase 1: publishers with an empty workspace get
              // three concrete starting points (including the sample
              // data seeder) instead of a gray dashed box. Viewers
              // and folder/shared scopes keep the plain empty state.
              <WelcomePanel canPublish />
            ) : (<EmptyState
              icon={<Layers className="h-5 w-5" />}
              title={
                activeFolder
                  ? t('itemsPage.emptyFolderTitle', { folder: activeFolder.title }, locale)
                  : isMine
                    ? t('itemsPage.emptyMineTitle', undefined, locale)
                    : t('itemsPage.emptySharedTitle', undefined, locale)
              }
              description={
                activeFolder
                  ? t('itemsPage.emptyFolderDescription', undefined, locale)
                  : isMine
                    ? t('itemsPage.emptyMineDescription', undefined, locale)
                    : t('itemsPage.emptySharedDescription', undefined, locale)
              }
              action={
                isMine && !activeFolder ? (
                  <Link
                    href="/items/new"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
                  >
                    <Plus className="h-4 w-4" />
                    {t('itemsPage.createAnItem', undefined, locale)}
                  </Link>
                ) : null
              }
            />))
          ) : (
            <ItemsView
              items={items}
              currentUser={me}
              folders={folders}
              activeFolder={
                activeFolder
                  ? { id: activeFolder.id, title: activeFolder.title }
                  : null
              }
              geoBoundaries={geoBoundaries.map((b) => ({
                id: b.id,
                title: b.title,
              }))}
            />
          )}
        </>
      </FoldersDrawer>
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