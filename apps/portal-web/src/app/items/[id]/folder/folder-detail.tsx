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
  Sparkles,
  X,
} from 'lucide-react';
import type {
  FolderData,
  FolderSmartQuery,
  ItemWithShares,
} from '@gratis-gis/shared-types';
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
            -- when on, anyone who can see an ancestor folder also sees
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
 * Smart-folder editor panel (#38). Compact form with five fields
 * matching FolderSmartQuery: type (multi-select via comma-
 * separated list), free-text q, owner UUID, optional limit.
 * bbox / bufferKm are not surfaced here -- they're awkward to
 * type into a folder editor and the more natural authoring path
 * is "draw a polygon, save as smart folder," which can land in a
 * follow-up. Today the API still honours them when present.
 *
 * Save fires on form submit (Enter or the Save button) so casual
 * typing doesn't hammer PATCH. Toggle off demotes back to a
 * static folder; the parent restores prior childItemIds via the
 * existing PATCH path.
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
  const [draftType, setDraftType] = useState<string>(() =>
    Array.isArray(smartQuery?.type)
      ? smartQuery!.type.join(',')
      : (smartQuery?.type ?? ''),
  );
  const [draftQ, setDraftQ] = useState<string>(smartQuery?.q ?? '');
  const [draftOwner, setDraftOwner] = useState<string>(
    smartQuery?.ownerId ?? '',
  );
  const [draftLimit, setDraftLimit] = useState<string>(() =>
    typeof smartQuery?.limit === 'number' ? String(smartQuery!.limit) : '',
  );

  function buildQuery(): FolderSmartQuery {
    const next: FolderSmartQuery = {};
    if (draftType.trim().length > 0) next.type = draftType.trim();
    if (draftQ.trim().length > 0) next.q = draftQ.trim();
    if (draftOwner.trim().length > 0) next.ownerId = draftOwner.trim();
    const lim = Number(draftLimit);
    if (Number.isFinite(lim) && lim > 0) next.limit = Math.floor(lim);
    return next;
  }

  return (
    <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          id="folder-is-smart"
          type="checkbox"
          checked={isSmart}
          disabled={saving}
          onChange={(e) => {
            // Toggle on with whatever drafts the user has typed
            // so the first save isn't an empty query (which would
            // resolve to "every item the user can see"). Toggle
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
          -- contents come from a saved query, not a hand-curated list.
        </span>
        {saving ? (
          <span className="ml-auto text-[10px] uppercase text-muted">
            Saving...
          </span>
        ) : null}
      </div>

      {isSmart ? (
        <form
          className="mt-2 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onChange(buildQuery());
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Type (comma-separated)
            </span>
            <input
              type="text"
              value={draftType}
              onChange={(e) => setDraftType(e.target.value)}
              placeholder="map, data_layer, ..."
              className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Search text
            </span>
            <input
              type="text"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              placeholder="title, description, or tag substring"
              className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Owner UUID
            </span>
            <input
              type="text"
              value={draftOwner}
              onChange={(e) => setDraftOwner(e.target.value)}
              placeholder="optional"
              className="h-7 rounded border border-border bg-surface-1 px-2 font-mono text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
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
          <div className="sm:col-span-2 flex items-center justify-end gap-2">
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