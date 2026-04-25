import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, FolderTree } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { FoldersView, type FolderRow } from './folders-view';

/**
 * Folders surface (#37, broadened from the admin-only version).
 *
 * Lists every folder the caller can see, with a breadcrumb path,
 * owner, access level, and child count. Available to every signed-in
 * user; the visibility scope follows the same per-item authz the
 * items list uses, so non-admins only see folders that have been
 * shared with them or that they own.
 *
 * Per docs/folders.md: any flat folder listing carries a breadcrumb
 * to disambiguate name collisions like "Project A > Surveys" vs
 * "Project B > Surveys".
 */
export default async function FoldersPage() {
  // Make sure the user is signed in. If apiFetch throws (no
  // session, expired token), bounce to /items which redirects
  // unauthenticated users to the landing page upstream.
  try {
    await apiFetch<{ id: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }

  let folders: ItemWithShares[] = [];
  let listError: string | null = null;
  try {
    folders = await apiFetch<ItemWithShares[]>('/api/items?type=folder');
  } catch (err) {
    listError =
      (err instanceof Error && err.message) ||
      'Could not load folders from the API.';
  }

  const rows = buildBreadcrumbRows(folders);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to items
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <FolderTree className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="text-2xl font-semibold tracking-tight">Folders</h1>
        </div>
      </header>

      {listError ? (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {listError}
        </div>
      ) : null}

      <FoldersView rows={rows} />
    </div>
  );
}

/**
 * Pure helper: take the visible folder rows and emit a list with a
 * `breadcrumb` (slash-joined title path from a top-level ancestor)
 * and `childCount` for the table. Multi-parent folders pick the
 * first parent encountered, matching the rail tree's behaviour.
 */
function buildBreadcrumbRows(
  folders: ItemWithShares[],
): FolderRow[] {
  const byId = new Map<string, ItemWithShares>();
  for (const f of folders) byId.set(f.id, f);

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