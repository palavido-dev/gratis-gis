'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Plus,
  X,
} from 'lucide-react';
import type { FolderData, ItemWithShares } from '@gratis-gis/shared-types';
import { DEFAULT_FOLDER } from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';

/** A single hop in the parent breadcrumb. Server-computed so the
 *  detail page renders the path without a client round-trip. */
export interface FolderBreadcrumbHop {
  id: string;
  title: string;
}

interface Props {
  itemId: string;
  initial: FolderData;
  /** Pre-resolved children, in the folder's authoritative order. */
  initialChildren: ItemWithShares[];
  /**
   * Parent path from a top-level ancestor down to this folder's
   * direct parent (NOT including this folder). Empty when this
   * folder is top-level. Multi-parent folders pick the first parent
   * encountered server-side; the rail tree shows multi-parent
   * presentation properly. See docs/folders.md.
   */
  breadcrumb: FolderBreadcrumbHop[];
  /** Whether the caller can edit this folder. */
  canEdit: boolean;
  /** Whether the caller can create new items in this org. Used to
   *  gate the "+ New subfolder" affordance. */
  canCreate: boolean;
}

/**
 * Detail surface for a folder item. Renders the folder's children as
 * a grid (reusing ItemCard so the visual is identical to /items),
 * plus author affordances: the parent shell handles rename + describe;
 * "Remove from folder" lives here per row when the caller can edit.
 * "+ New subfolder" lands the user in the wizard with the folder type
 * pre-selected and a parentFolderId hint so the new folder gets
 * appended to this folder's childItemIds atomically.
 *
 * See docs/folders.md.
 */
export function FolderDetail({
  itemId,
  initial,
  initialChildren,
  breadcrumb,
  canEdit,
  canCreate,
}: Props) {
  const router = useRouter();
  const [children, setChildren] = useState<ItemWithShares[]>(initialChildren);
  // Local copy of childItemIds so reorder writes don't depend on a
  // server round-trip before the next drop is allowed.
  const [orderedIds, setOrderedIds] = useState<string[]>(
    initial.childItemIds,
  );
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // Re-fetch contents on mount so a navigation that happened while
  // Next.js's router cache held a stale render (e.g. after the user
  // added items to this folder via the items-page bulk action and
  // got pushed back here) shows the up-to-date list. The SSR
  // `initialChildren` covers first paint; this overwrites with the
  // current server state shortly after.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${itemId}/folder-contents`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const next = (await res.json()) as ItemWithShares[];
        setChildren(next);
        // Also refresh orderedIds so the parent's authoritative order
        // matches what the server just returned. Drop ids that no
        // longer point at a visible row (purged, unshared, trashed).
        const visibleIds = new Set<string>(next.map((c) => String(c.id)));
        setOrderedIds((prev) => {
          const merged = prev.filter((id) => visibleIds.has(id));
          for (const c of next) {
            const cid = String(c.id);
            if (!merged.includes(cid)) merged.push(cid);
          }
          return merged;
        });
      } catch {
        /* non-fatal: SSR data still rendered */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // useMemo retained so future filters can derive from orderedIds
  // without invalidating the visibleCount calculation below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const childIds = useMemo(() => orderedIds.filter(Boolean), [orderedIds]);
  const visibleCount = children.length;
  const totalRefs = childIds.length;

  // Default ordering for the list: subfolders alphabetical first,
  // then everything else alphabetical. Drag-drop reorder writes to
  // `orderedIds` and overrides this; once the user has manually
  // ordered the folder we honour their order. We detect "no manual
  // order" as "orderedIds matches childItemIds in initial order"
  // since we never write through reorderChildren without changing
  // both. For Phase 1c we just always sort -- manual reorder is
  // tracked separately in childItemIds and survives the sort
  // because reorderChildren writes to both. Sort applies whenever
  // the parent's saved order is the default ingest order; users
  // can opt back into the manual order in a later slice.
  const sortedChildren = useMemo(() => {
    const copy = [...children];
    copy.sort((a, b) => {
      const af = a.type === 'folder' ? 0 : 1;
      const bf = b.type === 'folder' ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
    return copy;
  }, [children]);

  async function removeFromFolder(childId: string) {
    setError(null);
    setRemoving((prev) => new Set(prev).add(childId));
    try {
      const next: FolderData = {
        ...initial,
        childItemIds: orderedIds.filter((id: string) => id !== childId),
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
      }
      setChildren((prev) => prev.filter((c) => c.id !== childId));
      setOrderedIds(next.childItemIds);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setRemoving((prev) => {
        const n = new Set(prev);
        n.delete(childId);
        return n;
      });
    }
  }

  /**
   * HTML5 drag-and-drop handler used to reorder children inside this
   * folder. We commit each reorder to the server immediately so a
   * page navigation does not lose the new order; the optimistic
   * local update keeps the row visibly in its new spot during the
   * round-trip. On failure we revert and surface the error.
   *
   * Cross-folder drag-and-drop (move a folder into another) is a
   * Phase 1b follow-up; for now this only reorders within the
   * current folder. See docs/folders.md.
   */
  async function reorderChildren(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const prevOrder = orderedIds;
    const next = [...orderedIds];
    const from = next.indexOf(sourceId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    setOrderedIds(next);
    setReordering(true);
    setError(null);
    // Mirror the order on the visible children list so the grid
    // re-renders in the new order without waiting for a refetch.
    setChildren((cur) => {
      const byId = new Map<string, ItemWithShares>(
        cur.map((c) => [String(c.id), c]),
      );
      const reordered: ItemWithShares[] = [];
      for (const id of next) {
        const c = byId.get(id);
        if (c) reordered.push(c);
      }
      return reordered;
    });
    try {
      const payload: FolderData = { ...initial, childItemIds: next };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reorder failed');
      setOrderedIds(prevOrder);
      // Restore the visible list to its prior order on failure.
      setChildren((cur) => {
        const byId = new Map<string, ItemWithShares>(
        cur.map((c) => [String(c.id), c]),
      );
        const reordered: ItemWithShares[] = [];
        for (const id of prevOrder) {
          const c = byId.get(id);
          if (c) reordered.push(c);
        }
        return reordered;
      });
    } finally {
      setReordering(false);
      setDragId(null);
    }
  }

  return (
    <section className="space-y-4">
      {breadcrumb.length > 0 ? (
        <nav
          className="flex flex-wrap items-center gap-1 text-xs text-muted"
          aria-label="Folder breadcrumb"
        >
          {breadcrumb.map((hop, idx) => (
            <span key={hop.id} className="inline-flex items-center gap-1">
              <FolderIcon className="h-3 w-3 text-amber-700" />
              <Link
                href={`/items/${hop.id}`}
                className="hover:text-ink-1 hover:underline"
              >
                {hop.title}
              </Link>
              <ChevronRight className="h-3 w-3 text-muted/60" />
              {idx === breadcrumb.length - 1 ? (
                <span className="font-medium text-ink-1">(this folder)</span>
              ) : null}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {visibleCount === totalRefs
            ? `${totalRefs} item${totalRefs === 1 ? '' : 's'}`
            : `${visibleCount} visible (${totalRefs - visibleCount} hidden by access)`}
        </div>
        <div className="flex items-center gap-2">
          {canCreate ? (
            <Link
              href={`/items/new?type=folder&parentFolderId=${itemId}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs text-ink-1 hover:bg-surface-2"
              title="Create a new subfolder inside this folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New subfolder
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              href={`/items?addToFolder=${itemId}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent/90"
              title="Pick existing items to add to this folder"
            >
              <Plus className="h-3.5 w-3.5" />
              Add items
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {children.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-1 px-6 py-10 text-center text-sm text-muted">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-muted/70" />
          {totalRefs === 0
            ? 'This folder is empty. Add items from the items list, or create a subfolder.'
            : "You can't see any of the items currently in this folder. Ask the folder author to share them with you."}
        </div>
      ) : (
        // List view (rows). Subfolders sort alphabetically at the
        // top, then everything else alphabetically. Reuses the same
        // dragstart / drop machinery for child reorder, but applied
        // to row elements rather than card tiles.
        <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
          <ul className="divide-y divide-border">
            {sortedChildren.map((child) => {
              const Icon = getItemTypeIcon(child.type);
              const accent = getItemTypeAccent(child.type);
              const busy = removing.has(child.id);
              const dragging = dragId === child.id;
              return (
                <li
                  key={child.id}
                  draggable={canEdit && !reordering}
                  onDragStart={(e) => {
                    if (!canEdit) return;
                    setDragId(child.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', child.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    if (!canEdit || !dragId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(e) => {
                    if (!canEdit || !dragId) return;
                    e.preventDefault();
                    void reorderChildren(dragId, child.id);
                  }}
                  className={`group flex items-center gap-3 px-3 py-2 hover:bg-surface-2 transition-opacity ${
                    dragging ? 'opacity-40' : ''
                  }`}
                >
                  <Link
                    href={`/items/${child.id}`}
                    className="flex flex-1 items-center gap-3 min-w-0"
                  >
                    <span
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 ${accent}`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="flex flex-1 flex-col min-w-0">
                      <span className="truncate text-sm font-medium text-ink-1 group-hover:text-accent">
                        {child.title}
                      </span>
                      {child.description ? (
                        <span className="truncate text-xs text-muted">
                          {child.description}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                  <span
                    className={`hidden shrink-0 text-[10px] uppercase tracking-wide sm:inline ${accent}`}
                  >
                    {getItemTypeLabel(child.type)}
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-muted lg:inline">
                    {new Date(child.updatedAt).toLocaleDateString()}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => removeFromFolder(child.id)}
                      disabled={busy}
                      aria-label={`Remove ${child.title} from this folder`}
                      title="Remove from this folder (does not delete the item)"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-surface-1 hover:text-ink-1 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? (
                        <span className="text-[9px]">...</span>
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

// DEFAULT_FOLDER pulled at the import site so the bundler keeps the
// module-load path identical to the wizard's shape on first paint.
export const _FolderDetailDefaults = DEFAULT_FOLDER;