'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Eye,
  FolderMinus,
  FolderPlus,
  MoreVertical,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';

/**
 * Per-row kebab menu on the items list (#82). Surfaces the
 * single-row equivalents of the bulk-action bar plus the new
 * "Preview data" path that opens an attribute drawer without
 * navigating away from the list.
 *
 * Click handling: every menu item stops propagation so the kebab
 * never triggers the row's parent <Link>. Outside-click and
 * Escape both close the popover so the user can dismiss without
 * picking an action.
 */

const PREVIEWABLE_TYPES: ReadonlySet<ItemType> = new Set([
  'data_layer',
  'arcgis_service',
]);

interface Props {
  itemId: string;
  itemType: ItemType;
  canManage: boolean;
  onPreview?: (() => void) | undefined;
  onShare?: (() => void) | undefined;
  onMoveToFolder?: (() => void) | undefined;
  onMoveToTrash?: (() => void) | undefined;
  /** Only set when the user is currently viewing INSIDE a folder
   *  (?folder=<id>); shows a "Remove from this folder" menu item
   *  alongside the rest. Action splices the row's id out of the
   *  folder's data.childItemIds, doesn't delete the item (#92). */
  onRemoveFromFolder?: (() => void) | undefined;
  /** Folder title shown in the menu item label so the admin
   *  knows which folder they're removing from. */
  folderTitle?: string | undefined;
}

export function ItemRowMenu({
  itemId,
  itemType,
  canManage,
  onPreview,
  onShare,
  onMoveToFolder,
  onMoveToTrash,
  onRemoveFromFolder,
  folderTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const previewable = PREVIEWABLE_TYPES.has(itemType) && onPreview;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Item actions"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          // Right-anchored so the menu doesn't run off the page
          // edge when the row is near the right side.
          className="absolute right-0 top-8 z-30 w-52 overflow-hidden rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <a
            role="menuitem"
            href={`/items/${itemId}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            className="flex items-center gap-2 px-3 py-2 text-ink-1 hover:bg-surface-2"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted" />
            <span className="flex-1">Open</span>
          </a>
          {previewable ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPreview!();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
            >
              <Eye className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">Preview data</span>
            </button>
          ) : null}
          {canManage && onShare ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onShare();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
            >
              <UsersIcon className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">Share</span>
            </button>
          ) : null}
          {canManage && onMoveToFolder ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onMoveToFolder();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">Move to folder</span>
            </button>
          ) : null}
          {canManage && onRemoveFromFolder ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onRemoveFromFolder();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
            >
              <FolderMinus className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">
                {folderTitle
                  ? `Remove from "${folderTitle}"`
                  : 'Remove from this folder'}
              </span>
            </button>
          ) : null}
          {canManage && onMoveToTrash ? (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onMoveToTrash();
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-danger hover:bg-danger/5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">Move to trash</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
