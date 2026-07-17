// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react';
import { FolderRowMenu } from './folder-row-menu';
import { useAlert } from '@/components/dialog-provider';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';

/** MIME-style key used to identify an item-card drag payload (#43).
 *  Kept narrow (`application/x-gratis-item`) so other dragged content
 *  (text, files) is ignored cleanly by the rail's drop targets. */
export const ITEM_DRAG_MIME = 'application/x-gratis-item';

/**
 * Lightweight folder representation passed in from the server. We only
 * need id, title, and the childItemIds array so the rail can compute
 * the parent / child relationships without a second API call.
 */
export interface FolderRailNode {
  id: string;
  title: string;
  /** UUIDs from data.childItemIds. Children that are themselves
   *  folders show up as expandable nodes; non-folder children are
   *  not rendered in the rail (they belong in the items grid). */
  childItemIds: string[];
  /** Whether the caller can edit this folder (rename, share, trash,
   *  reorder children). Computed server-side from ownership +
   *  org-role; the rail uses it to gate the kebab-menu Trash item. */
  canEdit: boolean;
}

interface Props {
  /** Every folder the caller can see in this org. */
  folders: FolderRailNode[];
  /** Currently-active folder id, used to highlight a row when the
   *  user is on a folder detail page. */
  activeFolderId?: string | undefined;
}

/**
 * Left-rail folder tree for the items page. Top-level folders are
 * rendered eagerly (top-level = no other folder claims this folder
 * as a child); subfolders render on expand. A folder may sit in
 * multiple parents (multi-membership / DAG); the rail tolerates
 * that by rendering the folder under each of its parents.
 *
 * The rail itself does not paginate the items grid; clicking a
 * folder row navigates to /items/[id], where the folder detail page
 * renders the resolved children. This keeps the rail purely a
 * navigation surface and the grid purely a content surface.
 *
 * See docs/folders.md.
 */
export function FolderRail({ folders, activeFolderId }: Props) {
  const t = useT();
  const router = useRouter();
  const alert = useAlert();
  const folderById = useMemo(() => {
    const m = new Map<string, FolderRailNode>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // A folder is "top-level" if no other folder's childItemIds
  // contains its id. We compute this by collecting every id that
  // appears as a child of some folder; anything not in that set is
  // a root. Sorted by title (case-insensitive) so the rail order
  // is predictable regardless of insertion order.
  const topLevel = useMemo(() => {
    const claimed = new Set<string>();
    for (const f of folders) {
      for (const c of f.childItemIds) claimed.add(c);
    }
    return folders
      .filter((f) => !claimed.has(f.id))
      .slice()
      .sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
  }, [folders]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Folder id currently under a drag-over (highlighted as drop
  // target). Cleared on drop / leave. Lives on the FolderRail so
  // only one folder is highlighted at a time even when nested
  // expansions overlap. (#43)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(
    null,
  );
  // #90: inline create state. `null` = no edit row open, `'root'`
  // = creating a top-level folder, `<folderId>` = creating a
  // subfolder under that folder. The inline edit row reads these
  // to decide where to render. Mutually exclusive: starting a new
  // create cancels any in-flight one.
  const [creatingUnder, setCreatingUnder] = useState<
    string | 'root' | null
  >(null);
  function startCreate(parent: string | 'root') {
    setCreatingUnder(parent);
    if (parent !== 'root') {
      // Auto-expand the parent so the user can see the inline row
      // they're about to type into.
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
    }
  }
  async function commitCreate(title: string, parent: string | 'root') {
    const trimmed = title.trim();
    if (!trimmed) {
      setCreatingUnder(null);
      return;
    }
    try {
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'folder',
          title: trimmed,
          // childItemIds=[] keeps the new folder valid against the
          // FolderData shape; access defaults to private on create
          // server-side, which matches the user's "default to
          // private or inherit" preference for top-level folders.
          // Subfolder access is left at server default for now;
          // inheriting the parent's access tier is a separate
          // refinement (the parent might not be loaded here).
          data: { childItemIds: [] },
        }),
      });
      if (!res.ok) {
        await alert({
          tone: 'warn',
          title: 'Could not create folder',
          message: `Server returned ${res.status}. Try again or use the full New Item form.`,
        });
        return;
      }
      // If we're creating a subfolder, splice the new id into the
      // parent's childItemIds via a follow-up PATCH. The folder
      // hierarchy lives on the parent's data.childItemIds; the new
      // folder isn't claimed by anyone until the parent updates.
      if (parent !== 'root') {
        const created = (await res.json()) as { id?: string };
        const parentNode = folderById.get(parent);
        if (created.id && parentNode) {
          await fetch(`/api/portal/items/${parent}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              data: {
                childItemIds: [...parentNode.childItemIds, created.id],
              },
            }),
          });
        }
      }
      setCreatingUnder(null);
      router.refresh();
    } catch (err) {
      await alert({
        tone: 'warn',
        title: 'Could not create folder',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Drop an item onto a folder. (#43, #42)
   *
   * Two semantics, distinguished by whether the items grid is
   * currently filtered to a folder:
   *   - `?folder=<A>` and drop onto B: MOVE. Item leaves A, joins
   *     B. Matches the file-explorer convention where dragging
   *     from inside a folder relocates the file. (#42)
   *   - Browsing the all-items view (no `?folder=` filter) and
   *     drop onto B: ADD. Item joins B; existing parents are
   *     untouched. Matches the multi-membership DAG model where
   *     an item can sit in any number of folders.
   *
   * Server enforces cycle prevention (assertNoFolderCycle); a
   * folder dropped onto its own descendant 400s with a clear
   * message that we surface via window.alert. Idempotent: an
   * item that's already in the destination folder is a no-op.
   */
  async function dropItemIntoFolder(itemId: string, folderId: string) {
    if (!itemId || !folderId || itemId === folderId) return;
    try {
      // Add to the destination folder.
      const destRes = await fetch(`/api/portal/items/${folderId}`);
      if (!destRes.ok) {
        throw new Error(`Could not load folder (${destRes.status}).`);
      }
      const dest = (await destRes.json()) as {
        data?: { childItemIds?: unknown };
      };
      const destExisting = Array.isArray(dest.data?.childItemIds)
        ? (dest.data!.childItemIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];
      // Build the move-source patch in parallel only when we're in
      // a "drag from inside folder A" context. activeFolderId
      // matches the folder the items grid is currently filtered to;
      // if it's set and != the drop target, the item leaves it.
      const moveSourceId =
        activeFolderId && activeFolderId !== folderId ? activeFolderId : null;

      // Skip the dest patch when the item already lives there
      // (idempotent re-drop). Still process the move-source removal
      // since the user clearly intended the relocation.
      const tasks: Array<Promise<Response>> = [];
      if (!destExisting.includes(itemId)) {
        const next = {
          ...(dest.data ?? {}),
          childItemIds: [...destExisting, itemId],
        };
        tasks.push(
          fetch(`/api/portal/items/${folderId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: next }),
          }),
        );
      }
      if (moveSourceId) {
        // Fetch + patch the source folder to splice the item out.
        // Sequential within this branch because we need the source's
        // current childItemIds before we can rewrite them; the
        // outer Promise.all parallelises destination add with
        // source remove.
        tasks.push(
          (async () => {
            const srcRes = await fetch(
              `/api/portal/items/${moveSourceId}`,
            );
            if (!srcRes.ok) return srcRes;
            const src = (await srcRes.json()) as {
              data?: { childItemIds?: unknown };
            };
            const before = Array.isArray(src.data?.childItemIds)
              ? (src.data!.childItemIds as unknown[]).filter(
                  (x): x is string => typeof x === 'string',
                )
              : [];
            const after = before.filter((x) => x !== itemId);
            if (after.length === before.length) {
              // Item wasn't in the source; nothing to remove.
              return new Response(null, { status: 200 });
            }
            return fetch(`/api/portal/items/${moveSourceId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                data: { ...(src.data ?? {}), childItemIds: after },
              }),
            });
          })(),
        );
      }
      const results = await Promise.all(tasks);
      for (const r of results) {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(body || `Drop rejected (${r.status}).`);
        }
      }
      router.refresh();
    } catch (err) {
      // Transient failure feedback: a drag-drop miss shouldn't block
      // the user behind a modal, so this is a toast rather than
      // useAlert (#173).
      toast.error(t('folderRail.moveFailedTitle'), {
        description:
          err instanceof Error ? err.message : t('folderRail.moveFailedMessage'),
      });
    }
  }

  if (folders.length === 0) {
    return (
      <aside className="w-56 shrink-0 rounded-lg border border-dashed border-border bg-surface-1 px-3 py-3 text-xs text-muted">
        <div className="mb-2 flex items-center gap-1.5 font-medium uppercase tracking-wide">
          <FolderIcon className="h-3.5 w-3.5" />
          {t('nav.folders')}
        </div>
        <p>
          {t('folderRail.emptyPrefix')}{' '}
          <Link href="/items/new?type=folder" className="text-accent hover:underline">
            {t('folderRail.createOne')}
          </Link>{' '}
          {t('folderRail.emptySuffix')}
        </p>
      </aside>
    );
  }

  // Sticky relative to the page scroll so drag-and-drop into a
  // folder still works when the user has scrolled the items grid.
  // `top-4` aligns with the page's py-10 padding so the rail
  // anchors just below the viewport top. `max-h` + scroll keeps a
  // long folder tree usable without pushing the page height up.
  return (
    <aside className="sticky top-4 max-h-[calc(100vh-2rem)] w-56 shrink-0 self-start overflow-y-auto">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <FolderIcon className="h-3.5 w-3.5" />
          {t('nav.folders')}
        </span>
        <button
          type="button"
          onClick={() => startCreate('root')}
          className="text-2xs normal-case tracking-normal text-accent hover:underline"
        >
          {t('folderRail.newButton')}
        </button>
      </div>
      <ul className="space-y-0.5 text-sm">
        {/* #90: inline create row pinned to the top of the tree
            when the user clicks "+ New" at the rail header. Same
            row component renders nested under a folder when
            "New subfolder" is picked from the kebab. */}
        {creatingUnder === 'root' ? (
          <FolderCreateRow
            depth={0}
            onCommit={(title) => commitCreate(title, 'root')}
            onCancel={() => setCreatingUnder(null)}
          />
        ) : null}
        {topLevel.map((f) => (
          <FolderNode
            key={f.id}
            folder={f}
            depth={0}
            folderById={folderById}
            expanded={expanded}
            onToggle={toggle}
            activeFolderId={activeFolderId}
            dragOverFolderId={dragOverFolderId}
            onDragOver={setDragOverFolderId}
            onDrop={dropItemIntoFolder}
            creatingUnder={creatingUnder}
            onStartCreate={startCreate}
            onCommitCreate={commitCreate}
            onCancelCreate={() => setCreatingUnder(null)}
          />
        ))}
      </ul>
    </aside>
  );
}

interface NodeProps {
  folder: FolderRailNode;
  depth: number;
  folderById: Map<string, FolderRailNode>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  activeFolderId?: string | undefined;
  dragOverFolderId: string | null;
  onDragOver: (id: string | null) => void;
  onDrop: (itemId: string, folderId: string) => void | Promise<void>;
  /** #90: inline-create plumbing. `creatingUnder` is the parent
   *  id (or 'root') with an active edit row; `onStartCreate` is
   *  fired from the kebab's "New subfolder"; commit/cancel close
   *  the row. */
  creatingUnder: string | 'root' | null;
  onStartCreate: (parent: string | 'root') => void;
  onCommitCreate: (
    title: string,
    parent: string | 'root',
  ) => void | Promise<void>;
  onCancelCreate: () => void;
}

function FolderNode({
  folder,
  depth,
  folderById,
  expanded,
  onToggle,
  activeFolderId,
  dragOverFolderId,
  onDragOver,
  onDrop,
  creatingUnder,
  onStartCreate,
  onCommitCreate,
  onCancelCreate,
}: NodeProps) {
  const t = useT();
  // Children of this folder that are themselves folders (and that
  // the caller can see). Items that are not folders belong in the
  // grid, not the rail. Sorted by title (case-insensitive); the
  // folder's authoritative childItemIds order is preserved on the
  // detail page itself, but the rail wants alphabetical so the
  // tree reads predictably.
  const subfolders = folder.childItemIds
    .map((id) => folderById.get(id))
    .filter((f): f is FolderRailNode => !!f)
    .sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    );

  const isOpen = expanded.has(folder.id);
  const isActive = activeFolderId === folder.id;
  const hasSubs = subfolders.length > 0;
  const isDropTarget = dragOverFolderId === folder.id;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-1 transition-colors ${
          isDropTarget
            ? 'bg-accent/20 ring-1 ring-accent ring-inset'
            : isActive
              ? 'bg-accent/10 text-accent'
              : 'text-ink-1 hover:bg-surface-2'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onDragOver={(e) => {
          // Only respond to item-card drags. Other drag payloads
          // (text, files) leave the dropEffect at the browser
          // default so the user gets a 'no-drop' cursor.
          const types = e.dataTransfer.types;
          if (
            (types.includes && types.includes(ITEM_DRAG_MIME)) ||
            Array.from(types).includes(ITEM_DRAG_MIME)
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!isDropTarget) onDragOver(folder.id);
          }
        }}
        onDragLeave={() => {
          if (isDropTarget) onDragOver(null);
        }}
        onDrop={(e) => {
          const itemId = e.dataTransfer.getData(ITEM_DRAG_MIME);
          if (!itemId) return;
          e.preventDefault();
          onDragOver(null);
          void onDrop(itemId, folder.id);
        }}
      >
        <button
          type="button"
          onClick={() => onToggle(folder.id)}
          aria-label={isOpen ? t('folderRail.collapse') : t('folderRail.expand')}
          aria-expanded={isOpen}
          className={`inline-flex h-4 w-4 items-center justify-center rounded text-muted hover:text-ink-1 ${
            hasSubs ? '' : 'invisible'
          }`}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
        </button>
        {/* Click filters the items grid to this folder's contents
            instead of navigating to a separate detail page. The
            file-explorer model: rail = navigation, grid = content.
            Right-click anywhere on the row OR click the kebab to
            get "Open details", "Share", "New subfolder", "Trash".
            See docs/folders.md. */}
        <Link
          href={`/items?folder=${folder.id}`}
          className="flex flex-1 items-center gap-1.5 truncate"
          title={folder.title}
          onContextMenu={(e) => {
            // Forward right-click to the row menu. The menu component
            // catches the event on its kebab button too; we replicate
            // here so a click anywhere on the row works.
            const btn = e.currentTarget.parentElement?.querySelector(
              `button[aria-label^="Actions for"]`,
            ) as HTMLButtonElement | null;
            if (btn) {
              e.preventDefault();
              btn.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: false,
                  clientX: e.clientX,
                  clientY: e.clientY,
                }),
              );
            }
          }}
        >
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-warn" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-warn" />
          )}
          <span className="truncate">{folder.title}</span>
        </Link>
        <FolderRowMenu
          folderId={folder.id}
          folderTitle={folder.title}
          canEdit={folder.canEdit}
          onCreateSubfolder={onStartCreate}
        />
      </div>
      {/* #90: render the inline create row directly under this
          folder when the user picked "New subfolder" from its
          kebab. The row appears whether the folder has existing
          subfolders or not, so empty parents still get an entry
          point. Auto-expand handled in startCreate so the user
          sees the row even if the folder was collapsed. */}
      {isOpen && creatingUnder === folder.id ? (
        <ul className="space-y-0.5">
          <FolderCreateRow
            depth={depth + 1}
            onCommit={(title) => onCommitCreate(title, folder.id)}
            onCancel={onCancelCreate}
          />
        </ul>
      ) : null}
      {isOpen && hasSubs ? (
        <ul className="space-y-0.5">
          {subfolders.map((sub) => (
            <FolderNode
              key={sub.id}
              folder={sub}
              depth={depth + 1}
              folderById={folderById}
              expanded={expanded}
              onToggle={onToggle}
              activeFolderId={activeFolderId}
              dragOverFolderId={dragOverFolderId}
              onDragOver={onDragOver}
              onDrop={onDrop}
              creatingUnder={creatingUnder}
              onStartCreate={onStartCreate}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * #90: inline-create row. Looks like a folder row but renders an
 * autofocused text input in place of the title. Enter / blur
 * commits with the current value; Escape / blur-empty cancels.
 * Parent owns the POST + tree-refresh via the onCommit callback.
 */
function FolderCreateRow({
  depth,
  onCommit,
  onCancel,
}: {
  depth: number;
  onCommit: (title: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // Mount-focus so the user can type immediately after picking
  // "+ New" / "New subfolder" without needing to click the input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  async function commit() {
    if (busy) return;
    setBusy(true);
    try {
      await onCommit(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded-md bg-accent/5 px-2 py-1 ring-1 ring-accent/30"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="inline-flex w-3.5 shrink-0" aria-hidden />
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-warn" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            // Blur-with-content commits, blur-empty cancels.
            // Mirrors Windows Explorer's "click away to save" UX.
            if (value.trim()) void commit();
            else onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (value.trim()) void commit();
              else onCancel();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          disabled={busy}
          placeholder={t('folderRail.folderNamePlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink-1 placeholder:text-muted/60 focus:outline-none disabled:opacity-60"
        />
      </div>
    </li>
  );
}