'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react';

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
  const folderById = useMemo(() => {
    const m = new Map<string, FolderRailNode>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // A folder is "top-level" if no other folder's childItemIds
  // contains its id. We compute this by collecting every id that
  // appears as a child of some folder; anything not in that set is
  // a root.
  const topLevel = useMemo(() => {
    const claimed = new Set<string>();
    for (const f of folders) {
      for (const c of f.childItemIds) claimed.add(c);
    }
    return folders.filter((f) => !claimed.has(f.id));
  }, [folders]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (folders.length === 0) {
    return (
      <aside className="w-56 shrink-0 rounded-lg border border-dashed border-border bg-surface-1 px-3 py-3 text-xs text-muted">
        <div className="mb-2 flex items-center gap-1.5 font-medium uppercase tracking-wide">
          <FolderIcon className="h-3.5 w-3.5" />
          Folders
        </div>
        <p>
          No folders yet. <Link href="/items/new?type=folder" className="text-accent hover:underline">Create one</Link> to organize your items.
        </p>
      </aside>
    );
  }

  return (
    <aside className="w-56 shrink-0">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <FolderIcon className="h-3.5 w-3.5" />
          Folders
        </span>
        <Link
          href="/items/new?type=folder"
          className="text-[11px] normal-case tracking-normal text-accent hover:underline"
        >
          + New
        </Link>
      </div>
      <ul className="space-y-0.5 text-sm">
        {topLevel.map((f) => (
          <FolderNode
            key={f.id}
            folder={f}
            depth={0}
            folderById={folderById}
            expanded={expanded}
            onToggle={toggle}
            activeFolderId={activeFolderId}
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
}

function FolderNode({
  folder,
  depth,
  folderById,
  expanded,
  onToggle,
  activeFolderId,
}: NodeProps) {
  // Children of this folder that are themselves folders (and that
  // the caller can see). Items that are not folders belong in the
  // grid, not the rail.
  const subfolders = folder.childItemIds
    .map((id) => folderById.get(id))
    .filter((f): f is FolderRailNode => !!f);

  const isOpen = expanded.has(folder.id);
  const isActive = activeFolderId === folder.id;
  const hasSubs = subfolders.length > 0;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
          isActive ? 'bg-accent/10 text-accent' : 'text-ink-1 hover:bg-surface-2'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => onToggle(folder.id)}
          aria-label={isOpen ? 'Collapse folder' : 'Expand folder'}
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
            Right-click / kebab on the row will surface "Open
            details", "Share", etc. (Phase 1c slice 2).
            See docs/folders.md. */}
        <Link
          href={`/items?folder=${folder.id}`}
          className="flex flex-1 items-center gap-1.5 truncate"
          title={folder.title}
        >
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-700" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-700" />
          )}
          <span className="truncate">{folder.title}</span>
        </Link>
      </div>
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
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}