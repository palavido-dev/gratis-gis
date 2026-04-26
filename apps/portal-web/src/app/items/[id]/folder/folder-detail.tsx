'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Loader2,
  Plus,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type {
  FolderData,
  FolderSmartQuery,
  FolderSmartSearchField,
  ItemAccess,
  ItemShare,
  ItemType,
  ItemWithShares,
} from '@gratis-gis/shared-types';
import { DEFAULT_FOLDER, ITEM_TYPES } from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';
import {
  PrincipalPicker,
  type PrincipalOption,
} from '@/components/principal-picker';

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
  /**
   * The folder's own direct share rows. Used by the "Apply folder
   * sharing to all items" bulk action so the dialog can offer the
   * folder's existing audience as the only valid recipient set.
   * Sharing items inside a folder with someone who can't see the
   * folder itself made no sense in the prior version of the dialog.
   */
  folderShares: ItemShare[];
  /** The folder's own visibility ('private' | 'org' | 'public').
   *  Surfaced in the bulk-share dialog so the user understands the
   *  audience the action will target. */
  folderAccess: ItemAccess;
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
  folderShares,
  folderAccess,
}: Props) {
  const router = useRouter();
  const [children, setChildren] = useState<ItemWithShares[]>(initialChildren);
  // Local mirror of inheritsParentShares so the toggle gives instant
  // feedback. Defaults to true when the field isn't set (matches the
  // backend default in shared-types).
  const [inheritsParentShares, setInheritsParentShares] = useState<boolean>(
    initial.inheritsParentShares !== false,
  );
  const [inheritSaving, setInheritSaving] = useState(false);
  // Local copy of childItemIds so reorder writes don't depend on a
  // server round-trip before the next drop is allowed.
  const [orderedIds, setOrderedIds] = useState<string[]>(
    initial.childItemIds,
  );
  // Smart-folder state (#38). When `smartQuery` is non-null this
  // folder is "smart": its contents come from the saved query
  // instead of childItemIds. The saved query is mirrored locally
  // so the editor gives instant feedback before the PATCH lands.
  const [smartQuery, setSmartQuery] = useState<FolderSmartQuery | null>(
    initial.smartQuery ?? null,
  );
  const [smartSaving, setSmartSaving] = useState(false);
  const isSmart = smartQuery !== null;
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  // "Apply folder sharing to all items" bulk action (#64, #67).
  // Opens a dialog that copies each direct share row from this
  // folder onto every visible child the caller has admin on. No
  // cascading magic. Each share is a real, auditable grant
  // identical to a direct share.
  const [shareAllOpen, setShareAllOpen] = useState(false);

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
  // both. For Phase 1c we just always sort. Manual reorder is
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

  /**
   * Toggle the inheritsParentShares flag (#44 phase 1c slice 3a).
   * On = ancestor folders' shares cascade down through this folder.
   * Off = chain breaks here; this folder and its children only
   * honour their own direct shares plus anything inherited from
   * folders WITHIN this subtree.
   */
  async function toggleInherits() {
    if (!canEdit) return;
    const next = !inheritsParentShares;
    setInheritsParentShares(next);
    setInheritSaving(true);
    setError(null);
    try {
      const payload: FolderData = {
        ...initial,
        inheritsParentShares: next,
        childItemIds: orderedIds,
      };
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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Inheritance toggle failed');
      setInheritsParentShares(!next);
    } finally {
      setInheritSaving(false);
    }
  }

  /**
   * Save the smart-folder query (#38). Pass `null` to demote a
   * smart folder back to a static folder; the saved childItemIds
   * survive the round-trip so toggling smart off restores prior
   * curation. Optimistic local state with rollback on failure.
   */
  async function saveSmartQuery(next: FolderSmartQuery | null) {
    if (!canEdit) return;
    const prev = smartQuery;
    setSmartQuery(next);
    setSmartSaving(true);
    setError(null);
    try {
      // Build the new FolderData. When demoting (next === null),
      // OMIT smartQuery so exactOptionalPropertyTypes is satisfied
      // and the resolver's `data.smartQuery` check sees `undefined`
      // rather than `null` (either works at runtime, but the type
      // shape only allows omission, not explicit null).
      const { smartQuery: _drop, ...base } = initial;
      const payload: FolderData = next
        ? { ...base, childItemIds: orderedIds, smartQuery: next }
        : { ...base, childItemIds: orderedIds };
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
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Smart-folder save failed.',
      );
      setSmartQuery(prev);
    } finally {
      setSmartSaving(false);
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
          {canEdit && children.length > 0 && folderShares.length > 0 ? (
            <button
              type="button"
              onClick={() => setShareAllOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs text-ink-1 hover:bg-surface-2"
              title="Apply this folder's sharing to every item inside it. Each item ends up with the same share rows the folder has."
            >
              <Users className="h-3.5 w-3.5" />
              Apply folder sharing
            </button>
          ) : null}
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

      {shareAllOpen ? (
        <ShareAllItemsDialog
          items={children}
          folderShares={folderShares}
          folderAccess={folderAccess}
          onClose={() => setShareAllOpen(false)}
          onShared={() => {
            setShareAllOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      {/* Inheritance toggle (#44 phase 1c slice 3a). Only meaningful
          when this folder has a parent (top-level folders have
          nothing to inherit from); we render the toggle anyway so
          the user can flip it on early in case the folder later
          becomes a subfolder. */}
      {canEdit ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs">
          <input
            id="inherits-parent-shares"
            type="checkbox"
            checked={inheritsParentShares}
            onChange={toggleInherits}
            disabled={inheritSaving}
            className="h-3.5 w-3.5 rounded border-border"
          />
          <label
            htmlFor="inherits-parent-shares"
            className="cursor-pointer text-ink-1"
          >
            Inherit shares from parent folder(s)
          </label>
          <span className="text-muted">
            when on, anyone who can see an ancestor folder also sees
            this one's contents.
          </span>
          {inheritSaving ? (
            <span className="ml-auto text-[10px] uppercase text-muted">
              Saving...
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Smart-folder editor (#38). Smart folders compute their
          contents from a saved query at view time instead of a
          curated childItemIds list. Toggle on to convert; the
          existing childItemIds is preserved so toggling back
          restores the prior curation. While smart, drag-drop
          reorder and per-item Remove are hidden because they
          would no-op against a query-driven membership. */}
      {canEdit ? (
        <SmartFolderPanel
          smartQuery={smartQuery}
          isSmart={isSmart}
          saving={smartSaving}
          onChange={saveSmartQuery}
        />
      ) : null}

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
                  // Smart folders compute their order from the
                  // query (#38) so manual reorder is suppressed.
                  // Static folders keep the existing drag-drop.
                  draggable={canEdit && !reordering && !isSmart}
                  onDragStart={(e) => {
                    if (!canEdit || isSmart) return;
                    setDragId(child.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', child.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    if (!canEdit || !dragId || isSmart) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(e) => {
                    if (!canEdit || !dragId || isSmart) return;
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
                  {canEdit && !isSmart ? (
                    // Per-item Remove only makes sense on a static
                    // folder; smart folder membership is computed
                    // from the saved query so removing a row would
                    // be a no-op until the query was edited.
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

/**
 * "Apply folder sharing to all items" bulk dialog (#64, #67).
 *
 * Folder shares grant access to the folder itself, not its contents
 * (#63). When an author wants to share a whole project's worth of
 * items with a teammate, the natural intent is "share these items
 * with the same people the folder is shared with." So this dialog
 * has no recipient picker. It copies each direct share row from the
 * folder onto every child item: same principal, same permission,
 * same geo limit. Each item ends up with a real, auditable share
 * row identical to one set manually.
 *
 * Earlier versions of the dialog let the user pick any user or
 * group on the portal, which produced the disjoint experience of
 * being able to bulk-share items inside a folder with someone who
 * couldn't see the folder itself. Scoping the action to the folder's
 * own audience keeps folder visibility and item visibility coherent.
 *
 * Items the caller can't admin (someone else's items inside their
 * folder) are silently skipped: the per-share endpoint already gates
 * on canAdmin and would 403 anyway. The dialog tells the user how
 * many items are in scope before they commit and reports successes
 * vs skips after.
 */
function ShareAllItemsDialog({
  items,
  folderShares,
  folderAccess,
  onClose,
  onShared,
}: {
  items: ItemWithShares[];
  folderShares: ItemShare[];
  folderAccess: ItemAccess;
  onClose: () => void;
  onShared: () => void;
}) {
  const eligibleCount = items.length;
  const shareCount = folderShares.length;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    failed: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve user display names for the folder's user-shares so the
  // summary list shows real names instead of UUID prefixes. Same
  // pattern as sharing-panel.tsx. Group shares can't be resolved
  // here without a parallel groups fetch, so they fall back to a
  // short "Group <prefix>" label, which is fine for a confirmation
  // surface (the user already configured these on the folder).
  const userIds = useMemo(
    () =>
      folderShares
        .filter((s) => s.principalType === 'user')
        .map((s) => s.principalId),
    [folderShares],
  );
  const userIdsKey = useMemo(() => userIds.slice().sort().join(','), [userIds]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (userIds.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/portal/users?ids=${encodeURIComponent(userIds.join(','))}`,
        );
        if (!r.ok) return;
        const rows = (await r.json()) as Array<{
          id: string;
          username: string;
          fullName: string | null;
        }>;
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const u of rows) {
          next[u.id] = u.fullName?.trim() || u.username;
        }
        setUserNames(next);
      } catch {
        /* non-fatal: rows fall back to short id labels */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIdsKey]);

  function labelFor(share: ItemShare): string {
    if (share.principalType === 'user') {
      return (
        userNames[share.principalId] ?? `User ${share.principalId.slice(0, 8)}`
      );
    }
    return `Group ${share.principalId.slice(0, 8)}`;
  }

  async function commit() {
    if (folderShares.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, failed: 0 });
    let done = 0;
    let failed = 0;
    // For each item, fan out one POST per folder share. We count an
    // "item" as done if at least one share landed (or all were
    // skipped because the recipient already had a share at that
    // item, which the API treats as idempotent). If every share for
    // an item failed with non-2xx, count it as a skip.
    for (const item of items) {
      let itemHadAtLeastOneOk = false;
      let itemHadAtLeastOneFail = false;
      for (const share of folderShares) {
        try {
          // Forward the same permission, geoLimit, geoBoundaryId.
          // rowScope and other v3 fields aren't on ItemShare yet, so
          // they default server-side. The /share endpoint upserts
          // (re-POST with same principal updates the permission), so
          // re-running this action is safe.
          const body: Record<string, unknown> = {
            principalType: share.principalType,
            principalId: share.principalId,
            permission: share.permission,
          };
          if (share.geoBoundaryId) {
            body.geoBoundaryId = share.geoBoundaryId;
          } else if (share.geoLimit) {
            body.geoLimit = share.geoLimit;
          }
          const res = await fetch(`/api/portal/items/${item.id}/share`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            itemHadAtLeastOneOk = true;
          } else {
            // 403: caller doesn't have admin on this item.
            // 400/404: bad principal or moved item. All are silent
            // skips for the bulk action.
            itemHadAtLeastOneFail = true;
          }
        } catch {
          itemHadAtLeastOneFail = true;
        }
      }
      if (itemHadAtLeastOneOk) {
        done += 1;
      } else if (itemHadAtLeastOneFail) {
        failed += 1;
      }
      setProgress({ done, failed });
    }
    setBusy(false);
    if (failed > 0 && done === 0) {
      setError(
        `Could not share any items. You may not be the owner or an admin on these items.`,
      );
      return;
    }
    onShared();
  }

  const audienceNote =
    folderAccess === 'public'
      ? 'This folder is public, so anyone can already see it. The action below copies its direct share rows onto each item.'
      : folderAccess === 'org'
        ? 'This folder is visible to your whole organization. The action below copies its direct share rows onto each item too.'
        : 'The action below copies this folder\'s direct share rows onto each item, so the people you shared the folder with also see the items inside.';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Apply folder sharing to all items"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Users className="h-4 w-4" />
            Apply folder sharing to all items
          </h3>
          <p className="mt-1 text-xs text-muted">{audienceNote}</p>
        </div>

        <div className="space-y-3 px-4 py-4 text-sm">
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
              Will share with ({shareCount})
            </span>
            <ul className="divide-y divide-border rounded border border-border bg-surface-1 text-xs">
              {folderShares.map((s) => (
                <li
                  key={`${s.principalType}:${s.principalId}`}
                  className="flex items-center gap-2 px-2 py-1.5"
                >
                  <span className="flex-1 truncate text-ink-0">
                    {labelFor(s)}
                    {s.principalType === 'group' ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-muted">
                        group
                      </span>
                    ) : null}
                  </span>
                  <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    can {s.permission}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[11px] text-muted">
            This will update <strong>up to {eligibleCount}</strong>{' '}
            item{eligibleCount === 1 ? '' : 's'}. Items where you are
            not the owner or an admin are skipped. Re-running this is
            safe: existing shares are updated in place, not duplicated.
          </p>

          {progress ? (
            <div className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs">
              {busy ? (
                <span className="inline-flex items-center gap-2 text-ink-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Updated {progress.done} of {eligibleCount}
                  {progress.failed > 0
                    ? ` (${progress.failed} skipped)`
                    : ''}
                  ...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 text-success">
                  <Check className="h-3.5 w-3.5" />
                  Updated {progress.done} item
                  {progress.done === 1 ? '' : 's'}
                  {progress.failed > 0
                    ? `; ${progress.failed} skipped (no admin rights)`
                    : ''}
                </span>
              )}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy || shareCount === 0 || eligibleCount === 0}
            className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Applying...' : 'Apply sharing'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** All three search-fields keyed for the multi-select. Tuple
 *  rather than a Set so render order is stable and predictable. */
const SEARCH_FIELD_OPTIONS: ReadonlyArray<{
  key: FolderSmartSearchField;
  label: string;
}> = [
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'tags', label: 'Tags' },
];

/**
 * Smart-folder editor panel (#38, #61).
 *
 * Replaces the original raw-text-input prototype with proper
 * pickers so end users never need to think about UUIDs or
 * comma-separated-anything:
 *
 *   - Type: multi-select checkbox grid using the human label +
 *     icon for each ItemType from the central icon helper.
 *   - Search: free-text input PLUS a row of checkboxes that
 *     scope which fields the search runs against. Defaults to
 *     all three (title / description / tags) so existing
 *     behaviour is preserved if the user doesn't touch them.
 *   - Owner: PrincipalPicker (the same combobox the share
 *     dialog and the reassign-owner flow use). Searches
 *     /api/portal/users by name; the UUID is stored
 *     internally, the display shows the user's name with a
 *     "Clear" affordance.
 *   - Limit: kept as a plain number input. It's a number,
 *     no domain-specific knowledge required.
 *
 * Save fires on form submit so casual typing doesn't hammer
 * PATCH. Toggle off demotes back to a static folder via the
 * parent's existing PATCH path.
 */
function SmartFolderPanel({
  smartQuery,
  isSmart,
  saving,
  onChange,
}: {
  smartQuery: FolderSmartQuery | null;
  isSmart: boolean;
  saving: boolean;
  onChange: (next: FolderSmartQuery | null) => void | Promise<void>;
}) {
  // Initial type set: the saved query may have been a single
  // string, an array, or a comma-separated string from the old
  // text-input editor. Normalise to a Set for the checkboxes.
  const initialTypes: Set<string> = (() => {
    const t = smartQuery?.type;
    if (Array.isArray(t)) return new Set(t);
    if (typeof t === 'string' && t.length > 0) {
      return new Set(t.split(',').map((s) => s.trim()).filter(Boolean));
    }
    return new Set();
  })();
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    initialTypes,
  );
  const [draftQ, setDraftQ] = useState<string>(smartQuery?.q ?? '');
  const [searchFields, setSearchFields] = useState<
    Set<FolderSmartSearchField>
  >(() => {
    const f = smartQuery?.searchFields;
    if (Array.isArray(f) && f.length > 0) return new Set(f);
    return new Set(['title', 'description', 'tags']);
  });
  const [ownerId, setOwnerId] = useState<string>(smartQuery?.ownerId ?? '');
  const [ownerLabel, setOwnerLabel] = useState<string>('');
  const [draftLimit, setDraftLimit] = useState<string>(() =>
    typeof smartQuery?.limit === 'number' ? String(smartQuery!.limit) : '',
  );

  // When mounting with a pre-existing ownerId, fetch the
  // matching display name so the user sees "Alice" not the
  // UUID. Bounded one-shot lookup; failure is silent (the
  // editor falls back to showing the id, but at least the
  // Clear button still works).
  useEffect(() => {
    if (!ownerId || ownerLabel) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/users?ids=${encodeURIComponent(ownerId)}`,
        );
        if (!res.ok || cancelled) return;
        const rows = (await res.json()) as Array<{
          id: string;
          fullName?: string | null;
          username: string;
        }>;
        const hit = rows.find((r) => r.id === ownerId);
        if (hit) {
          setOwnerLabel(hit.fullName?.trim() || hit.username);
        }
      } catch {
        /* non-fatal: editor still functional without the label */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);

  function buildQuery(): FolderSmartQuery {
    const next: FolderSmartQuery = {};
    if (selectedTypes.size > 0) {
      // Use the array form so the server handles multi-type
      // cleanly without a parse step.
      next.type = Array.from(selectedTypes);
    }
    if (draftQ.trim().length > 0) {
      next.q = draftQ.trim();
      // Only persist searchFields when narrower than the
      // default (all three). Saves a couple of bytes and keeps
      // the saved query shape minimal for the common case.
      if (searchFields.size > 0 && searchFields.size < 3) {
        next.searchFields = Array.from(searchFields);
      }
    }
    if (ownerId) next.ownerId = ownerId;
    const lim = Number(draftLimit);
    if (Number.isFinite(lim) && lim > 0) next.limit = Math.floor(lim);
    return next;
  }

  function toggleType(t: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }
  function toggleSearchField(f: FolderSmartSearchField) {
    setSearchFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  async function searchUsers(q: string): Promise<PrincipalOption[]> {
    const url = `/api/portal/users${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
      id: string;
      username: string;
      fullName?: string | null;
      avatarUrl?: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.fullName?.trim() || r.username,
      subtitle: r.fullName?.trim() ? r.username : null,
      imageUrl: r.avatarUrl ?? null,
    }));
  }

  // Track expand/collapse separately from the smart toggle. Collapsed
  // by default so the page doesn't surface a giant editor every time
  // a smart folder is opened; the user expands when they actively
  // want to tweak the query. Auto-expand once when the user FLIPS
  // the smart toggle ON so they have somewhere to put their first
  // query without an extra click.
  const [expanded, setExpanded] = useState(false);
  const prevIsSmartRef = useRef(isSmart);
  useEffect(() => {
    if (!prevIsSmartRef.current && isSmart) setExpanded(true);
    prevIsSmartRef.current = isSmart;
  }, [isSmart]);

  return (
    <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          id="folder-is-smart"
          type="checkbox"
          checked={isSmart}
          disabled={saving}
          onChange={(e) => {
            // Toggle on with whatever drafts the user has set
            // so the first save isn't an empty query. Toggle
            // off passes null so the parent demotes the folder
            // back to static.
            if (e.target.checked) void onChange(buildQuery());
            else void onChange(null);
          }}
          className="h-3.5 w-3.5 rounded border-border"
        />
        <label
          htmlFor="folder-is-smart"
          className="inline-flex cursor-pointer items-center gap-1.5 text-ink-1"
        >
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          Smart folder
        </label>
        <span className="text-muted">
          contents come from a saved query, not a hand-curated list.
        </span>
        {saving ? (
          <span className="text-[10px] uppercase text-muted">
            Saving...
          </span>
        ) : null}
        {isSmart ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
            aria-expanded={expanded}
            aria-controls="smart-folder-form"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3 w-3" />
                Hide query
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" />
                Edit query
              </>
            )}
          </button>
        ) : null}
      </div>

      {isSmart && expanded ? (
        <form
          id="smart-folder-form"
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onChange(buildQuery());
          }}
        >
          {/* Type: multi-select checkbox grid. Each row shows
              the type's icon + human label so authors don't
              need to know that "feature service" became
              "data_layer". Empty selection = "any type". */}
          <fieldset>
            <legend className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              Item type
              {selectedTypes.size > 0 ? (
                <span className="ml-1 normal-case text-muted">
                  ({selectedTypes.size} selected)
                </span>
              ) : (
                <span className="ml-1 normal-case text-muted">
                  (any when none selected)
                </span>
              )}
            </legend>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {ITEM_TYPES.map((t) => {
                const Icon = getItemTypeIcon(t as ItemType);
                const checked = selectedTypes.has(t);
                return (
                  <label
                    key={t}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
                      checked
                        ? 'border-accent bg-accent/5 text-ink-0'
                        : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleType(t)}
                      className="h-3 w-3"
                    />
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {getItemTypeLabel(t as ItemType)}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Search text + which fields it targets. Default is
              all three checked so a user who just types in the
              search box gets the same behaviour as the items
              page's plain-text search. */}
          <div className="space-y-1">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                Search text
              </span>
              <input
                type="text"
                value={draftQ}
                onChange={(e) => setDraftQ(e.target.value)}
                placeholder="word or phrase to look for"
                className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px]">
              <span className="text-muted">Search in:</span>
              {SEARCH_FIELD_OPTIONS.map(({ key, label }) => {
                const checked = searchFields.has(key);
                return (
                  <label
                    key={key}
                    className="inline-flex cursor-pointer items-center gap-1 text-ink-1"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSearchField(key)}
                      className="h-3 w-3"
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Owner: searchable user picker. Stores the UUID
              internally; the user only ever sees the chosen
              name + a Clear button. */}
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
              Owner
            </span>
            {ownerId ? (
              <div className="flex items-center gap-2 rounded border border-border bg-surface-1 px-2 py-1 text-xs">
                <span className="flex-1 truncate text-ink-0">
                  {ownerLabel || `(user ${ownerId.slice(0, 8)})`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOwnerId('');
                    setOwnerLabel('');
                  }}
                  className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  Clear
                </button>
              </div>
            ) : (
              <PrincipalPicker
                placeholder="Search for a user (optional)"
                search={searchUsers}
                onPick={(option) => {
                  setOwnerId(option.id);
                  setOwnerLabel(option.title);
                }}
                emptyMessage="No matching users."
                emptyInitialMessage="Start typing a name to search."
              />
            )}
          </div>

          <label className="flex max-w-[12rem] flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Limit
            </span>
            <input
              type="number"
              min={1}
              max={1000}
              value={draftLimit}
              onChange={(e) => setDraftLimit(e.target.value)}
              placeholder="default 1000"
              className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
            />
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="h-7 rounded-md border border-accent bg-accent px-3 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-60"
            >
              Save query
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}