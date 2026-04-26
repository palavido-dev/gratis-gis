'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Check,
  ChevronRight,
  Crosshair,
  FolderPlus,
  Grid3x3,
  List as ListIcon,
  Loader2,
  Trash2,
  UserRound,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import {
  PrincipalPicker,
  type PrincipalOption,
} from '@/components/principal-picker';
import { DependentsWarning } from '@/components/dependents-warning';
import { ItemCard } from '@gratis-gis/ui';
import type {
  FolderData,
  ItemType,
  ItemWithShares,
} from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';
import { ItemSharingIndicator } from '@/components/item-sharing-indicator';
import { ReassignOwnerDialog } from '@/components/reassign-owner-dialog';
import { AreaSearchPanel } from './area-search-panel';
import { AddToFolderDialog } from './add-to-folder-dialog';
import { ITEM_DRAG_MIME, type FolderRailNode } from './folder-rail';

/**
 * Client-side wrapper around the items list. Owns three bits of UI
 * state that don't warrant a round-trip to the server:
 *
 *   - view mode (card vs list): persists via localStorage so the
 *     user's preference sticks between visits
 *   - type filters: one or more item types can be toggled on; empty
 *     means "show all"
 *   - group-by: 'none' (flat list), 'type', 'access'. Owner grouping
 *     is an obvious future addition but needs a user/name lookup we
 *     don't carry on the list response today.
 *
 * The server hands us the full item list (with shares joined) so all
 * filtering and grouping is in-memory; that's fine for org-sized
 * lists (up to a few thousand items). If it stops being fine we can
 * push filters back to the API without changing this component's
 * public shape.
 */
interface Props {
  items: ItemWithShares[];
  currentUser: { id: string; orgRole: string };
  /**
   * Folders the user can pick as targets for the "Add to folder"
   * bulk action. Server-fetched alongside items so the picker
   * dialog renders without a round-trip. Default empty so the
   * component still works in contexts that haven't wired folders
   * yet (e.g. tests).
   */
  folders?: FolderRailNode[];
}

type ViewMode = 'card' | 'list';
type GroupBy = 'none' | 'type' | 'access';
type SortBy =
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'title-asc'
  | 'title-desc';

const VIEW_MODE_KEY = 'gg.items.view';
const GROUP_BY_KEY = 'gg.items.groupBy';
const SORT_BY_KEY = 'gg.items.sortBy';

const SORT_LABELS: Record<SortBy, string> = {
  'updated-desc': 'Recently updated',
  'updated-asc': 'Least recently updated',
  'created-desc': 'Newest first',
  'created-asc': 'Oldest first',
  'title-asc': 'Name (A–Z)',
  'title-desc': 'Name (Z–A)',
};

const ACCESS_LABELS: Record<string, string> = {
  private: 'Private',
  org: 'Organization',
  public: 'Public',
};

export function ItemsView({ items, currentUser, folders = [] }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortBy, setSortBy] = useState<SortBy>('updated-desc');
  const [typeFilter, setTypeFilter] = useState<Set<ItemType>>(new Set());
  // Bulk-select state: ids of items the current user has ticked for
  // ownership reassignment. Kept as a Set so toggles are O(1). Only
  // items the user can manage (their own + all for admins) can land
  // here: gating happens in ItemGrid where each row is rendered.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showReassign, setShowReassign] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // "Add to folder" dialog. Distinct from the reassign flow because
  // the saving state and target picker shape differ; sharing one
  // generic dialog would have ended up with too many branches.
  const [showAddToFolder, setShowAddToFolder] = useState(false);
  const [folderSaving, setFolderSaving] = useState(false);
  // Bulk Share dialog (#77): pick a principal + permission, fan
  // out to one share-write per selected item. Items the caller
  // can't admin are silently skipped server-side.
  const [showBulkShare, setShowBulkShare] = useState(false);
  // Bulk Move-to-Trash confirmation (#77). Soft-delete only;
  // permanent purge stays a per-item action on the recycle-bin
  // page so a misclick on the items list can't lose data.
  const [showBulkTrash, setShowBulkTrash] = useState(false);
  // ?addToFolder=<id> query param flips this view into "pick items
  // to add to a specific folder" mode. The user got here from the
  // folder detail page's "Add items" button; we know the target
  // folder up front, so the bulk action skips the picker dialog
  // entirely and goes straight to "Add to <folder name>". After
  // success we send the user back to the folder detail page.
  const searchParams = useSearchParams();
  const addToFolderId = searchParams?.get('addToFolder') ?? null;
  const targetFolder = addToFolderId
    ? folders.find((f) => f.id === addToFolderId) ?? null
    : null;
  // Spatial-filter state (#24 + #29). When `spatialActive` is set, the
  // page renders `spatialItems` instead of the server-rendered `items`.
  // The fetch is fired by AreaSearchPanel's "Use this area" button. We
  // keep both the request (for the chip label + repaint on close) and
  // the result so dismissing the panel doesn't drop the filter.
  const [areaPanelOpen, setAreaPanelOpen] = useState(false);
  const [spatialBusy, setSpatialBusy] = useState(false);
  const [spatialError, setSpatialError] = useState<string | null>(null);
  const [spatialActive, setSpatialActive] = useState<{
    bbox: [number, number, number, number];
    bufferKm: number;
  } | null>(null);
  const [spatialItems, setSpatialItems] = useState<ItemWithShares[] | null>(
    null,
  );
  const router = useRouter();

  // Rehydrate persisted preferences on mount. Running this lazily
  // (not as a useState initializer) keeps the component SSR-safe
  // the first render always matches the server's ("card", "none").
  useEffect(() => {
    try {
      const vm = localStorage.getItem(VIEW_MODE_KEY);
      if (vm === 'card' || vm === 'list') setViewMode(vm);
      const gb = localStorage.getItem(GROUP_BY_KEY);
      if (gb === 'none' || gb === 'type' || gb === 'access') setGroupBy(gb);
      const sb = localStorage.getItem(SORT_BY_KEY);
      if (sb && sb in SORT_LABELS) setSortBy(sb as SortBy);
    } catch {
      /* no localStorage, fall through to defaults */
    }
  }, []);

  function persistView(next: ViewMode) {
    setViewMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }
  function persistGroup(next: GroupBy) {
    setGroupBy(next);
    try {
      localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      /* non-fatal */
    }
  }
  function persistSort(next: SortBy) {
    setSortBy(next);
    try {
      localStorage.setItem(SORT_BY_KEY, next);
    } catch {
      /* non-fatal */
    }
  }

  // Effective dataset: spatial-filter results when active, otherwise
  // the full server-rendered list. Type filtering and sorting always
  // run client-side over whichever set is in play. Folders are
  // intentionally hidden from the grid; they surface only through
  // the FolderRail tree on the left so the grid stays a content
  // surface rather than mixing organization and content. See
  // docs/folders.md.
  const sourceItems = (spatialActive && spatialItems
    ? spatialItems
    : items
  ).filter((it) => it.type !== 'folder');

  // Present-in-data type counts, sorted by descending count so the
  // most common types sit at the front of the filter bar. Counts
  // reflect the active spatial-search result when one is in play, so
  // the chips don't promise types the visible set doesn't contain.
  const typeCounts = useMemo(() => {
    const counts = new Map<ItemType, number>();
    for (const it of sourceItems)
      counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [sourceItems]);

  const filteredItems = useMemo(() => {
    const pool =
      typeFilter.size === 0
        ? sourceItems
        : sourceItems.filter((it) => typeFilter.has(it.type));
    // Sort on every filter/sort change. copyWithin keeps the original
    // array intact (it's the server prop).
    const sorted = [...pool];
    sorted.sort((a, b) => compareItems(a, b, sortBy));
    return sorted;
  }, [sourceItems, typeFilter, sortBy]);

  function toggleType(t: ItemType) {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function clearFilters() {
    setTypeFilter(new Set());
  }

  async function applyAreaSearch(
    bbox: [number, number, number, number],
    bufferKm: number,
  ) {
    setSpatialBusy(true);
    setSpatialError(null);
    try {
      const params = new URLSearchParams();
      params.set('bbox', bbox.join(','));
      if (bufferKm > 0) params.set('buffer', String(bufferKm));
      const res = await fetch(`/api/portal/items?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
      }
      const next = (await res.json()) as ItemWithShares[];
      setSpatialItems(next);
      setSpatialActive({ bbox, bufferKm });
      setAreaPanelOpen(false);
    } catch (e) {
      setSpatialError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSpatialBusy(false);
    }
  }

  function clearAreaSearch() {
    setSpatialActive(null);
    setSpatialItems(null);
    setSpatialError(null);
  }

  /**
   * Append the currently-selected items to the chosen folder. The
   * server's cycle-detection runs on save; we de-dupe on the client
   * so the request body is the smallest reasonable payload. Existing
   * memberships stay untouched (an item already in the folder is a
   * no-op rather than an error).
   *
   * In add-to-folder mode (?addToFolder=<id>), success redirects
   * back to the folder detail page so the user lands inside the
   * folder they just curated. Outside that mode the user stays on
   * the items list.
   */
  async function handleAddToFolder(folderId: string) {
    setFolderSaving(true);
    setBulkError(null);
    try {
      // Fetch the current folder so we know the existing childItemIds
      // and don't have to trust the rail snapshot to be up to date.
      const fres = await fetch(`/api/portal/items/${folderId}`);
      if (!fres.ok) {
        throw new Error(`Could not load folder: HTTP ${fres.status}`);
      }
      const folder = (await fres.json()) as { data: FolderData | null };
      const existing = Array.isArray(folder.data?.childItemIds)
        ? folder.data!.childItemIds
        : [];
      const seen = new Set(existing);
      const toAdd = Array.from(selected).filter((id) => !seen.has(id));
      if (toAdd.length === 0) {
        setShowAddToFolder(false);
        setSelected(new Set());
        return;
      }
      const next: FolderData = {
        version: 1,
        childItemIds: [...existing, ...toAdd],
      };
      const pres = await fetch(`/api/portal/items/${folderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: next }),
      });
      if (!pres.ok) {
        const body = await pres.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${pres.status}`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
      }
      setShowAddToFolder(false);
      setSelected(new Set());
      // In targeted add-to-folder mode, send the user back to the
      // folder detail page so they land where the new contents are
      // visible. Otherwise stay on the items page (the rail will
      // reflect the new membership on next refresh).
      if (addToFolderId === folderId) {
        router.push(`/items/${folderId}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Add to folder failed');
    } finally {
      setFolderSaving(false);
    }
  }

  // Items the user can manage (toggle into the selection). Admins can
  // manage everything; everyone else only their own. Bulk ops act
  // exclusively on this subset so the action bar can't trigger a 403
  // partway through a batch.
  const manageableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const it of filteredItems) {
      if (currentUser.orgRole === 'admin' || it.ownerId === currentUser.id) {
        ids.add(it.id);
      }
    }
    return ids;
  }, [filteredItems, currentUser]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    // Ticking the header checkbox ticks every manageable row in the
    // current filtered view. If they're already all selected, this
    // clears just the visible-and-manageable ones (leaving any
    // stale selections from a previous filter alone).
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = Array.from(manageableIds).every((id) => next.has(id));
      if (allSelected) {
        for (const id of manageableIds) next.delete(id);
      } else {
        for (const id of manageableIds) next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /**
   * Bulk soft-delete (#77). Iterates the selection and calls
   * DELETE /items/:id, which the API treats as "move to trash"
   * (deletedAt set, recoverable from the recycle bin). Items the
   * caller can't admin 403 silently and we count them as skipped;
   * the user never has to know which specific row tripped the
   * gate. router.refresh() reloads the list so the trashed items
   * disappear without a manual refresh.
   */
  async function handleBulkTrash() {
    setBulkSaving(true);
    setBulkError(null);
    let done = 0;
    let skipped = 0;
    try {
      for (const id of selected) {
        try {
          const res = await fetch(`/api/portal/items/${id}`, {
            method: 'DELETE',
          });
          if (res.ok || res.status === 204) {
            done += 1;
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }
      if (done === 0 && skipped > 0) {
        setBulkError(
          'No items moved to trash. You may not have admin rights on the selected items.',
        );
      } else if (skipped > 0) {
        setBulkError(
          `Moved ${done} item${done === 1 ? '' : 's'} to trash; skipped ${skipped} (no admin rights).`,
        );
      }
      setShowBulkTrash(false);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkSaving(false);
    }
  }

  /**
   * Bulk share (#77). Walks each selected item and POSTs the same
   * share row (principalType, principalId, permission). 403 on any
   * single item just means the caller doesn't have admin on that
   * one; it stays an internal skip rather than aborting the rest.
   * Re-running is safe: the share endpoint upserts, so the same
   * principal getting the same permission twice is a no-op.
   */
  async function handleBulkShare(
    principal: PrincipalOption,
    permission: 'view' | 'download' | 'edit' | 'admin',
  ) {
    setBulkSaving(true);
    setBulkError(null);
    const [principalType, principalId] = principal.id.split(':') as [
      'user' | 'group',
      string,
    ];
    let done = 0;
    let skipped = 0;
    try {
      for (const id of selected) {
        try {
          const res = await fetch(`/api/portal/items/${id}/share`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              principalType,
              principalId,
              permission,
            }),
          });
          if (res.ok) {
            done += 1;
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }
      if (done === 0 && skipped > 0) {
        setBulkError(
          'No shares were written. You may not have admin rights on the selected items.',
        );
      } else if (skipped > 0) {
        setBulkError(
          `Shared ${done} item${done === 1 ? '' : 's'}; skipped ${skipped} (no admin rights).`,
        );
      }
      setShowBulkShare(false);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkSaving(false);
    }
  }

  async function handleBulkReassign(
    newOwnerId: string,
    keepPreviousOwnerAccess: 'view' | 'download' | 'edit' | 'admin' | null,
  ) {
    setBulkSaving(true);
    setBulkError(null);
    try {
      const res = await fetch('/api/portal/items/bulk/reassign-owner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemIds: Array.from(selected),
          newOwnerId,
          keepPreviousOwnerAccess,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
      }
      setShowReassign(false);
      setSelected(new Set());
      // Refresh the server-rendered list so ownerId / owner fields
      // reflect the new reality. The alternative (local state patch)
      // would be faster but would risk drift with the "keep previous
      // access" share rows the API may or may not have created.
      router.refresh();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Reassign failed');
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div>
      {targetFolder ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <div className="flex items-center gap-2 text-ink-1">
            <FolderPlus className="h-4 w-4 text-accent" />
            <span>
              Adding items to:{' '}
              <span className="font-medium">{targetFolder.title}</span>.
              Tick items below and click "Add to {targetFolder.title}".
            </span>
          </div>
          <button
            type="button"
            onClick={() => router.push(`/items/${targetFolder.id}`)}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-1 px-2.5 text-xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
        </div>
      ) : null}
      <Toolbar
        viewMode={viewMode}
        onViewMode={persistView}
        groupBy={groupBy}
        onGroupBy={persistGroup}
        sortBy={sortBy}
        onSortBy={persistSort}
        typeFilter={typeFilter}
        typeCounts={typeCounts}
        onToggleType={toggleType}
        onClearFilters={clearFilters}
        totalCount={sourceItems.length}
        filteredCount={filteredItems.length}
        areaActive={!!spatialActive}
        areaActiveLabel={
          spatialActive
            ? formatAreaLabel(spatialActive.bbox, spatialActive.bufferKm)
            : null
        }
        areaPanelOpen={areaPanelOpen}
        onToggleAreaPanel={() => setAreaPanelOpen((v) => !v)}
        onClearAreaSearch={clearAreaSearch}
      />
      {areaPanelOpen ? (
        <AreaSearchPanel
          {...(spatialActive ? { initialBbox: spatialActive.bbox } : {})}
          {...(spatialActive ? { initialBufferKm: spatialActive.bufferKm } : {})}
          busy={spatialBusy}
          onApply={applyAreaSearch}
          onClose={() => setAreaPanelOpen(false)}
        />
      ) : null}
      {spatialError ? (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          {spatialError}
        </div>
      ) : null}
      {selected.size > 0 ? (
        <BulkActionBar
          count={selected.size}
          onReassign={() => setShowReassign(true)}
          onShare={() => setShowBulkShare(true)}
          onTrash={() => setShowBulkTrash(true)}
          onAddToFolder={
            folders.length > 0 ? () => setShowAddToFolder(true) : undefined
          }
          targetFolder={targetFolder}
          onAddToTargetFolder={
            targetFolder
              ? () => handleAddToFolder(targetFolder.id)
              : undefined
          }
          targetFolderSaving={folderSaving}
          onClear={clearSelection}
        />
      ) : null}
      <ItemsBody
        items={filteredItems}
        viewMode={viewMode}
        groupBy={groupBy}
        currentUser={currentUser}
        selected={selected}
        manageableIds={manageableIds}
        onToggleSelected={toggleSelected}
        onToggleAll={selectAllVisible}
      />
      {showReassign ? (
        <ReassignOwnerDialog
          heading={`Reassign ${selected.size} ${selected.size === 1 ? 'item' : 'items'}`}
          subheading="Pick the new owner; each item's existing shares are preserved."
          saving={bulkSaving}
          onClose={() => {
            if (!bulkSaving) {
              setShowReassign(false);
              setBulkError(null);
            }
          }}
          onSubmit={handleBulkReassign}
        />
      ) : null}
      {showAddToFolder ? (
        <AddToFolderDialog
          folders={folders}
          itemIds={Array.from(selected)}
          saving={folderSaving}
          onSubmit={handleAddToFolder}
          onClose={() => {
            if (!folderSaving) {
              setShowAddToFolder(false);
              setBulkError(null);
            }
          }}
        />
      ) : null}
      {showBulkShare ? (
        <BulkShareDialog
          count={selected.size}
          saving={bulkSaving}
          onSubmit={handleBulkShare}
          onClose={() => {
            if (!bulkSaving) {
              setShowBulkShare(false);
              setBulkError(null);
            }
          }}
        />
      ) : null}
      {showBulkTrash ? (
        <BulkTrashDialog
          count={selected.size}
          itemIds={Array.from(selected)}
          saving={bulkSaving}
          onConfirm={handleBulkTrash}
          onClose={() => {
            if (!bulkSaving) {
              setShowBulkTrash(false);
              setBulkError(null);
            }
          }}
        />
      ) : null}
      {bulkError ? (
        <div className="fixed bottom-4 right-4 max-w-md rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger shadow-raised">
          {bulkError}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Sticky bar that appears when one or more items are selected. */
function BulkActionBar({
  count,
  onReassign,
  onShare,
  onTrash,
  onAddToFolder,
  targetFolder,
  onAddToTargetFolder,
  targetFolderSaving,
  onClear,
}: {
  count: number;
  onReassign: () => void;
  onShare: () => void;
  onTrash: () => void;
  onAddToFolder?: (() => void) | undefined;
  /** When set, the user came here via ?addToFolder= and we offer a
   *  one-click "Add to <folder>" button instead of the generic
   *  picker dialog. */
  targetFolder?: FolderRailNode | null;
  onAddToTargetFolder?: (() => void) | undefined;
  targetFolderSaving?: boolean;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 mb-3 flex items-center justify-between gap-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 shadow-sm">
      <div className="flex items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium text-accent">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">
            {count}
          </span>
          selected
        </span>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-1"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2">
        {targetFolder && onAddToTargetFolder ? (
          <button
            type="button"
            onClick={onAddToTargetFolder}
            disabled={!!targetFolderSaving}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {targetFolderSaving
              ? 'Adding...'
              : `Add to ${targetFolder.title}`}
          </button>
        ) : (
          <>
            {onAddToFolder ? (
              <button
                type="button"
                onClick={onAddToFolder}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                Add to folder
              </button>
            ) : null}
            <button
              type="button"
              onClick={onShare}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              <UsersIcon className="h-3.5 w-3.5" />
              Share
            </button>
            <button
              type="button"
              onClick={onTrash}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-danger/5 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Move to trash
            </button>
            <button
              type="button"
              onClick={onReassign}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90"
            >
              <UserRound className="h-3.5 w-3.5" />
              Reassign owner
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Bulk-share dialog (#77). Mirrors the per-folder "Share all items"
 * dialog: pick a principal, pick a permission, click Share. The
 * parent walks the selection and POSTs share rows; this component
 * just owns the form state.
 */
function BulkShareDialog({
  count,
  saving,
  onSubmit,
  onClose,
}: {
  count: number;
  saving: boolean;
  onSubmit: (
    principal: PrincipalOption,
    permission: 'view' | 'download' | 'edit' | 'admin',
  ) => void | Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<PrincipalOption | null>(null);
  const [permission, setPermission] = useState<
    'view' | 'download' | 'edit' | 'admin'
  >('view');

  async function search(q: string): Promise<PrincipalOption[]> {
    const [usersRes, groupsRes] = await Promise.allSettled([
      fetch(
        `/api/portal/users${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
      fetch(
        `/api/portal/groups${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
    ]);
    const out: PrincipalOption[] = [];
    if (usersRes.status === 'fulfilled' && usersRes.value.ok) {
      const rows = (await usersRes.value.json()) as Array<{
        id: string;
        username: string;
        fullName?: string | null;
        avatarUrl?: string | null;
      }>;
      for (const r of rows) {
        out.push({
          id: `user:${r.id}`,
          title: r.fullName?.trim() || r.username,
          subtitle: r.fullName?.trim() ? r.username : null,
          imageUrl: r.avatarUrl ?? null,
        });
      }
    }
    if (groupsRes.status === 'fulfilled' && groupsRes.value.ok) {
      const rows = (await groupsRes.value.json()) as Array<{
        id: string;
        title: string;
        description?: string | null;
        thumbnailUrl?: string | null;
      }>;
      for (const r of rows) {
        out.push({
          id: `group:${r.id}`,
          title: r.title,
          subtitle: r.description ?? null,
          imageUrl: r.thumbnailUrl ?? null,
        });
      }
    }
    return out;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share selected items"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <UsersIcon className="h-4 w-4" />
            Share selected items
          </h3>
          <p className="mt-1 text-xs text-muted">
            Each of the {count} selected item{count === 1 ? '' : 's'} gets
            its own share grant for the recipient you pick. Items where
            you are not the owner or an admin are skipped automatically.
          </p>
        </div>

        <div className="space-y-3 px-4 py-4 text-sm">
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
              Recipient
            </span>
            {picked ? (
              <div className="flex items-center gap-2 rounded border border-border bg-surface-1 px-2 py-1.5 text-xs">
                <span className="flex-1 truncate text-ink-0">
                  {picked.title}
                  {picked.id.startsWith('group:') ? (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-muted">
                      group
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  Clear
                </button>
              </div>
            ) : (
              <PrincipalPicker
                placeholder="Search for a user or group"
                search={search}
                onPick={setPicked}
                emptyMessage="No matching users or groups."
                emptyInitialMessage="Start typing a name to search."
              />
            )}
          </div>

          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
              Permission
            </span>
            <div className="grid grid-cols-2 gap-1">
              {(['view', 'download', 'edit', 'admin'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPermission(p)}
                  className={`rounded border px-2 py-1 text-left text-xs transition-colors ${
                    permission === p
                      ? 'border-accent bg-accent/5 text-ink-0'
                      : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                  }`}
                >
                  <div className="font-medium capitalize">{p}</div>
                  <div className="text-[10px] text-muted">
                    {p === 'view' && 'See the item'}
                    {p === 'download' && 'See + export bulk data'}
                    {p === 'edit' && 'See + change content'}
                    {p === 'admin' && 'Full control, including sharing'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => picked && void onSubmit(picked, permission)}
            disabled={saving || !picked}
            className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sharing...
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" />
                Share
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation dialog for the bulk move-to-trash action (#77). The
 * action is reversible (items go to the recycle bin and stay there
 * for the retention window) but a confirm step is still warranted
 * because the items disappear from the live list. The dialog leans
 * into "you can undo" copy so the user isn't anxious about a
 * misclick.
 */
function BulkTrashDialog({
  count,
  itemIds,
  saving,
  onConfirm,
  onClose,
}: {
  count: number;
  /** Selection ids passed through to the dependents warning (#78)
   *  so the dialog can show what will lose its reference if the
   *  user confirms. */
  itemIds: string[];
  saving: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Move selected items to trash"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Trash2 className="h-4 w-4 text-danger" />
            Move {count} {count === 1 ? 'item' : 'items'} to trash?
          </h3>
        </div>
        <div className="px-4 py-4 text-sm">
          <p className="text-ink-1">
            The selected {count === 1 ? 'item' : 'items'} will be moved to
            the recycle bin. You can restore them from the
            &quot;Recently deleted&quot; page.
          </p>
          <p className="mt-2 text-xs text-muted">
            Items where you are not the owner or an admin are skipped
            automatically.
          </p>
          {/* Aggregated warning: any other items in the org that
              reference one or more of the selection. The component
              filters out dependents that are themselves in the
              selection (those are trashing too). (#78) */}
          <DependentsWarning itemIds={itemIds} />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={saving}
            className="h-9 rounded-md bg-danger px-3 text-sm font-medium text-white hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Moving...
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Move to trash
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Render a one-line "Area:" chip subtitle from the captured bbox +
 * buffer. The bbox alone is too noisy (4 floats) for a chip, so we
 * collapse it into "centered at lat,lon, ~Wkm wide" plus the buffer
 * if any. Coordinates rounded to 2 decimals (~1km of precision).
 */
function formatAreaLabel(
  bbox: [number, number, number, number],
  bufferKm: number,
): string {
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  // Rough width in km: 1 deg lon at the centre's latitude is
  // 111.32 * cos(lat). Width is in degrees.
  const latRad = (cy * Math.PI) / 180;
  const widthKm = Math.max(1, Math.round((e - w) * 111.32 * Math.cos(latRad)));
  const center = `${cy.toFixed(2)}, ${cx.toFixed(2)}`;
  const tail = bufferKm > 0 ? `, +${bufferKm}km buffer` : '';
  return `centered at ${center} (~${widthKm}km wide${tail})`;
}

/**
 * Comparator shared by every sort mode. Tie-break on id so the ordering
 * is deterministic when two items have the same sort key.
 */
function compareItems(
  a: ItemWithShares,
  b: ItemWithShares,
  mode: SortBy,
): number {
  switch (mode) {
    case 'title-asc':
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    case 'title-desc':
      return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
    case 'created-desc':
      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'created-asc':
      return (
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'updated-asc':
      return (
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'updated-desc':
    default:
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
        a.id.localeCompare(b.id)
      );
  }
}

interface ToolbarProps {
  viewMode: ViewMode;
  onViewMode: (next: ViewMode) => void;
  groupBy: GroupBy;
  onGroupBy: (next: GroupBy) => void;
  sortBy: SortBy;
  onSortBy: (next: SortBy) => void;
  typeFilter: Set<ItemType>;
  typeCounts: Array<[ItemType, number]>;
  onToggleType: (t: ItemType) => void;
  onClearFilters: () => void;
  totalCount: number;
  filteredCount: number;
  areaActive: boolean;
  areaActiveLabel: string | null;
  areaPanelOpen: boolean;
  onToggleAreaPanel: () => void;
  onClearAreaSearch: () => void;
}

function Toolbar({
  viewMode,
  onViewMode,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
  typeFilter,
  typeCounts,
  onToggleType,
  onClearFilters,
  totalCount,
  filteredCount,
  areaActive,
  areaActiveLabel,
  areaPanelOpen,
  onToggleAreaPanel,
  onClearAreaSearch,
}: ToolbarProps) {
  return (
    <div className="mb-4 space-y-3">
      {/* Top row: view-mode toggle + group-by + showing-N summary */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-surface-1">
          <button
            type="button"
            onClick={() => onViewMode('card')}
            aria-pressed={viewMode === 'card'}
            className={`inline-flex h-8 items-center gap-1 px-2 text-xs ${
              viewMode === 'card'
                ? 'bg-accent/10 text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-ink-1'
            }`}
            title="Card view"
          >
            <Grid3x3 className="h-3.5 w-3.5" />
            Cards
          </button>
          <button
            type="button"
            onClick={() => onViewMode('list')}
            aria-pressed={viewMode === 'list'}
            className={`inline-flex h-8 items-center gap-1 border-l border-border px-2 text-xs ${
              viewMode === 'list'
                ? 'bg-accent/10 text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-ink-1'
            }`}
            title="List view"
          >
            <ListIcon className="h-3.5 w-3.5" />
            List
          </button>
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          Group by
          <select
            value={groupBy}
            onChange={(e) => onGroupBy(e.target.value as GroupBy)}
            className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            <option value="none">None</option>
            <option value="type">Type</option>
            <option value="access">Access</option>
          </select>
        </label>

        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          Sort
          <select
            value={sortBy}
            onChange={(e) => onSortBy(e.target.value as SortBy)}
            className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {(Object.entries(SORT_LABELS) as Array<[SortBy, string]>).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>

        <p className="ml-auto text-xs text-muted">
          {filteredCount === totalCount
            ? `${totalCount} item${totalCount === 1 ? '' : 's'}`
            : `${filteredCount} of ${totalCount}`}
        </p>
      </div>

      {areaActive && areaActiveLabel ? (
        <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-xs text-ink-1">
          <Crosshair className="h-3.5 w-3.5 text-accent" />
          <span className="text-muted">Area:</span>
          <span className="font-medium">{areaActiveLabel}</span>
          <button
            type="button"
            onClick={onClearAreaSearch}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted hover:text-ink-1"
          >
            <X className="h-3 w-3" />
            Clear area
          </button>
        </div>
      ) : null}

      {/* Filter chips. Only surface types that are actually present
          in the data so a fresh org doesn't see 13 greyed-out chips.
          The "Area" chip lives here too -- area is just another
          filter the user can toggle on/off, not a separate kind of
          search affordance. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
          Filter
        </span>

        <button
          type="button"
          onClick={onToggleAreaPanel}
          aria-pressed={areaPanelOpen || areaActive}
          title="Filter by geographic area"
          className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${
            areaPanelOpen || areaActive
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
          }`}
        >
          <Crosshair className="h-3 w-3" />
          {areaActive ? 'Area' : 'Area...'}
        </button>

        {typeCounts.map(([t, count]) => {
          const active = typeFilter.has(t);
          const Icon = getItemTypeIcon(t);
          const accent = getItemTypeAccent(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onToggleType(t)}
              aria-pressed={active}
              className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              <Icon className={`h-3 w-3 ${active ? '' : accent}`} />
              {getItemTypeLabel(t)}
              <span className="text-muted">({count})</span>
            </button>
          );
        })}
        {typeFilter.size > 0 || areaActive ? (
          <button
            type="button"
            onClick={() => {
              if (typeFilter.size > 0) onClearFilters();
              if (areaActive) onClearAreaSearch();
            }}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BodyProps {
  items: ItemWithShares[];
  viewMode: ViewMode;
  groupBy: GroupBy;
  currentUser: { id: string; orgRole: string };
  selected: Set<string>;
  manageableIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleAll: () => void;
}

function ItemsBody({
  items,
  viewMode,
  groupBy,
  currentUser,
  selected,
  manageableIds,
  onToggleSelected,
  onToggleAll,
}: BodyProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-6 py-10 text-center text-sm text-muted">
        No items match your filters.
      </div>
    );
  }

  if (groupBy === 'none') {
    return (
      <ItemGrid
        items={items}
        viewMode={viewMode}
        currentUser={currentUser}
        selected={selected}
        manageableIds={manageableIds}
        onToggleSelected={onToggleSelected}
        onToggleAll={onToggleAll}
      />
    );
  }

  // Group and render a section per bucket. Buckets are ordered by
  // size descending so the user's most-common bucket leads.
  const buckets = new Map<string, ItemWithShares[]>();
  for (const it of items) {
    const key = groupBy === 'type' ? it.type : it.access;
    const arr = buckets.get(key) ?? [];
    arr.push(it);
    buckets.set(key, arr);
  }
  const ordered = Array.from(buckets.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );

  return (
    <div className="space-y-6">
      {ordered.map(([key, group]) => {
        const label =
          groupBy === 'type'
            ? getItemTypeLabel(key as ItemType)
            : (ACCESS_LABELS[key] ?? key);
        return (
          <section key={key}>
            <h2 className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted">
              {label}
              <span className="text-muted">({group.length})</span>
            </h2>
            <ItemGrid
              items={group}
              viewMode={viewMode}
              currentUser={currentUser}
              selected={selected}
              manageableIds={manageableIds}
              onToggleSelected={onToggleSelected}
              onToggleAll={onToggleAll}
            />
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface GridProps {
  items: ItemWithShares[];
  viewMode: ViewMode;
  currentUser: { id: string; orgRole: string };
  selected: Set<string>;
  manageableIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleAll: () => void;
}

function ItemGrid({
  items,
  viewMode,
  currentUser,
  selected,
  manageableIds,
  onToggleSelected,
  onToggleAll,
}: GridProps) {
  if (viewMode === 'card') {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const canManage =
            currentUser.id === item.ownerId || currentUser.orgRole === 'admin';
          const Icon = getItemTypeIcon(item.type);
          return (
            <div
              key={item.id}
              className="group relative"
              draggable
              onDragStart={(e) => {
                // Drag-into-folder support (#43). The folder rail
                // listens for this MIME type; non-folder drop
                // targets get a no-op since browsers ignore unknown
                // MIME entries on dataTransfer.
                e.dataTransfer.setData(ITEM_DRAG_MIME, item.id);
                e.dataTransfer.setData('text/plain', item.title);
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              {canManage ? (
                <label
                  // Absolute-positioned checkbox so it sits on top of
                  // the card thumbnail without disrupting the grid
                  // cell math. Stops propagation so ticking doesn't
                  // also trigger the card's navigation link.
                  className={`absolute left-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded border bg-surface-1/90 backdrop-blur transition-opacity ${
                    selected.has(item.id)
                      ? 'border-accent opacity-100'
                      : 'border-border opacity-0 group-hover:opacity-100'
                  }`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => onToggleSelected(item.id)}
                    className="h-3.5 w-3.5"
                    aria-label={`Select ${item.title}`}
                  />
                </label>
              ) : null}
              <ItemCard
                item={item}
                href={`/items/${item.id}`}
                fallbackIcon={<Icon />}
                headerExtra={
                  <ItemSharingIndicator
                    itemId={item.id}
                    itemTitle={item.title}
                    access={item.access}
                    shares={item.shares}
                    canManage={canManage}
                    currentUserId={currentUser.id}
                    stopParentLink
                  />
                }
              />
            </div>
          );
        })}
      </div>
    );
  }

  // List view: compact rows in a CSS grid so every column (checkbox,
  // icon, title/desc, type, updated-at, sharing, chevron) aligns
  // vertically across rows. A checkbox column was prepended to support
  // bulk select + reassign; it's a fixed 1.5rem-wide column so the
  // layout is pixel-stable whether or not the user has admin rights
  // on any given row.
  const allManageableSelected =
    manageableIds.size > 0 &&
    Array.from(manageableIds).every((id) => selected.has(id));
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
      {/* Header row. Grid template has an extra 1.5rem leading column
          for the checkbox. The "select all visible" checkbox only
          appears when the current user can manage at least one row
          in this group: otherwise it'd be a no-op. */}
      <li className="hidden grid-cols-[1.5rem_auto_minmax(0,1fr)_8rem_8rem_7rem_9rem_auto] items-center gap-3 border-b border-border bg-surface-2 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted sm:grid">
        {manageableIds.size > 0 ? (
          <input
            type="checkbox"
            checked={allManageableSelected}
            onChange={onToggleAll}
            className="h-3.5 w-3.5 cursor-pointer"
            aria-label="Select all manageable items in this group"
          />
        ) : (
          <span className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span className="h-4 w-4" aria-hidden="true" />
        <span>Title</span>
        <span>Type</span>
        <span>Owner</span>
        <span>Updated</span>
        <span>Sharing</span>
        <span className="h-3.5 w-3.5" aria-hidden="true" />
      </li>
      {items.map((item) => {
        const canManage =
          currentUser.id === item.ownerId || currentUser.orgRole === 'admin';
        const Icon = getItemTypeIcon(item.type);
        const accent = getItemTypeAccent(item.type);
        // Prefer the lean owner projection joined by the API. Fall
        // back to a truncated id for pre-existing rows that somehow
        // reach us without it (shouldn't happen in practice).
        const ownerLabel = item.owner
          ? item.owner.id === currentUser.id
            ? 'you'
            : (item.owner.fullName?.trim() || item.owner.username)
          : item.ownerId.slice(0, 8);
        const isSelected = selected.has(item.id);
        return (
          <li
            key={item.id}
            className={`group ${isSelected ? 'bg-accent/5' : ''}`}
            draggable
            onDragStart={(e) => {
              // Mirrors the card-view drag (#43). Same MIME, same
              // payload shape, so the rail's drop handler doesn't
              // need to care which view the user dragged from.
              e.dataTransfer.setData(ITEM_DRAG_MIME, item.id);
              e.dataTransfer.setData('text/plain', item.title);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <div className="grid grid-cols-[1.5rem_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 hover:bg-surface-2 sm:grid-cols-[1.5rem_auto_minmax(0,1fr)_8rem_8rem_7rem_9rem_auto]">
              {/* Checkbox: rendered as a label that swallows its own
                  click so the row's Link doesn't fire under it. */}
              {canManage ? (
                <label
                  className="flex h-6 w-6 -ml-1 cursor-pointer items-center justify-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelected(item.id)}
                    className="h-3.5 w-3.5 cursor-pointer"
                    aria-label={`Select ${item.title}`}
                  />
                </label>
              ) : (
                <span className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <Link
                href={`/items/${item.id}`}
                className="contents"
                aria-label={item.title}
              >
                <Icon className={`h-4 w-4 shrink-0 ${accent}`} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-0">
                    {item.title}
                  </p>
                  {item.description ? (
                    <p className="truncate text-xs text-muted">
                      {item.description}
                    </p>
                  ) : null}
                </div>
                <p className="hidden truncate text-[11px] text-muted sm:block">
                  {getItemTypeLabel(item.type)}
                </p>
                <p
                  className="hidden truncate text-[11px] text-muted sm:block"
                  title={item.owner?.username ?? item.ownerId}
                >
                  {ownerLabel}
                </p>
                <p className="hidden text-[11px] text-muted sm:block">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </p>
              </Link>
              {/* Sharing + chevron sit outside the Link so their click
                  handlers don't propagate a navigation. */}
              <div className="hidden sm:block">
                <ItemSharingIndicator
                  itemId={item.id}
                  itemTitle={item.title}
                  access={item.access}
                  shares={item.shares}
                  canManage={canManage}
                  currentUserId={currentUser.id}
                  stopParentLink
                />
              </div>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
