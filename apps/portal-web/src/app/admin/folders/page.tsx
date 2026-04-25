import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, FolderTree } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { AdminFoldersView, type AdminFolderRow } from './admin-folders-view';

/**
 * Admin folders surface (#37 phase 1b).
 *
 * Lists every folder in the org with breadcrumbs, ownership, and
 * child counts so an admin can spot orphans, mass-shared bottlenecks,
 * and abandoned curated views in one place. The same data shows up
 * on the items page through the left-rail tree, but per the docs/
 * folders.md contract any flat folder listing carries a breadcrumb
 * to disambiguate name collisions like "Project A > Surveys" vs
 * "Project B > Surveys".
 *
 * Server-side guarded by org-admin like the other /admin pages.
 */
export default async function AdminFoldersPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  // Fetch every folder the admin can see. Admins see all org items
  // by default through the visibility helper.
  let folders: ItemWithShares[] = [];
  let listError: string | null = null;
  try {
    folders = await apiFetch<ItemWithShares[]>('/api/items?type=folder');
  } catch (err) {
    listError =
      (err instanceof Error && err.message) ||
      'Could not load folders from the API.';
  }

  // Compute breadcrumb strings client-side here (still server-side
  // for the page, but in JS rather than another API round-trip). A
  // folder's breadcrumb is the path of titles from the closest
  // top-level ancestor down. For multi-parent folders we pick the
  // first parent we encounter; the rail tree handles the multi-
  // parent presentation properly. See docs/folders.md.
  const rows = buildBreadcrumbRows(folders);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <FolderTree className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">Folders</h1>
        </div>
      </header>

      {listError ? (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {listError}
        </div>
      ) : null}

      <AdminFoldersView rows={rows} />
    </div>
  );
}

/**
 * Pure helper: take the org's folder rows and emit a list with
 * `breadcrumb` (slash-joined title path from a top-level ancestor)
 * and `childCount` for the admin table.
 */
function buildBreadcrumbRows(
  folders: ItemWithShares[],
): AdminFolderRow[] {
  const byId = new Map<string, ItemWithShares>();
  for (const f of folders) byId.set(f.id, f);

  // For breadcrumbs we need a parent map: child id -> first folder
  // that claims it. Sufficient for the typical tree case; multi-
  // parent folders pick the first parent encountered, which matches
  // the rail tree's first-render behaviour.
  const parentOf = new Map<string, string>();
  for (const f of folders) {
    const children = (f.data as { childItemIds?: unknown } | null)
      ?.childItemIds;
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      if (typeof c !== 'string') continue;
      if (!parentOf.has(c)) parentOf.set(c, f.id);
    }
  }

  function breadcrumbFor(id: string): string {
    const titles: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = byId.get(cur);
      if (!row) break;
      titles.unshift(row.title);
      cur = parentOf.get(cur);
    }
    return titles.join(' › ');
  }

  return folders.map((f) => {
    const children = (f.data as { childItemIds?: unknown } | null)
      ?.childItemIds;
    const childCount = Array.isArray(children) ? children.length : 0;
    return {
      id: f.id,
      title: f.title,
      breadcrumb: breadcrumbFor(f.id),
      ownerId: f.ownerId,
      ownerLabel:
        f.owner?.fullName?.trim() ||
        f.owner?.username ||
        f.ownerId.slice(0, 8),
      access: f.access,
      childCount,
      updatedAt: f.updatedAt,
    };
  });
}