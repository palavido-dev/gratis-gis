// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ClipboardList,
  ExternalLink,
  Eye,
  FolderMinus,
  FolderPlus,
  MoreVertical,
  Settings,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';

import { getItemHref, hasRuntime } from '@/lib/item-type-icon';
import { useT } from '@/lib/i18n/locale-context';

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
  /** Item data payload, forwarded to getItemHref / hasRuntime so
   *  templated web_apps (editor / viewer) deep-link to the right
   *  runtime route. Optional because many list callers only have
   *  the slim projection -- in that case Open falls back to the
   *  detail page and the Configure entry doesn't render. */
  itemData?: unknown;
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
  itemData,
  canManage,
  onPreview,
  onShare,
  onMoveToFolder,
  onMoveToTrash,
  onRemoveFromFolder,
  folderTitle,
}: Props) {
  const t = useT();
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
  // For runnable items (editor/viewer web_apps, data_collection),
  // Open targets the runtime URL ("end product") and a separate
  // Configure entry takes the user to the detail / config page.
  // Plain content types (data_layer, basemap, service, etc.) keep
  // a single Open that lands on the detail page.
  const openHref = getItemHref({ id: itemId, type: itemType, data: itemData });
  const isRunnable = hasRuntime({ type: itemType, data: itemData });
  const configureHref = `/items/${itemId}`;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('itemMenu.actions')}
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
          {/* Open targets the runtime / "end product" for runnable
              types -- the editor / viewer / field PWA -- and opens
              in a new tab so the runtime gets the full viewport
              and the items list stays available behind it. Only
              renders for items that HAVE a runtime; plain content
              types skip Open entirely and use Configure as the
              single entry, since "Open" otherwise just means
              "navigate to the detail page" (which is exactly what
              Configure does), and dual-labeling the same action
              breaks the verb's promise. */}
          {isRunnable ? (
            <a
              role="menuitem"
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-2 text-ink-1 hover:bg-surface-2"
            >
              <ExternalLink className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">{t('itemMenu.open')}</span>
            </a>
          ) : null}
          {/* #328: forms get a second runnable entry alongside Open
              -- "Responses" deep-links into the implicit Response
              Viewer (#321). Open targets the respondent runtime
              (someone fills out the form), Responses targets the
              authoring runtime (someone reads what was submitted),
              so they're complementary verbs, not redundant. */}
          {itemType === 'form' ? (
            <a
              role="menuitem"
              href={`/items/${itemId}/responses`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-2 text-ink-1 hover:bg-surface-2"
            >
              <ClipboardList className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1">{t('itemMenu.responses')}</span>
            </a>
          ) : null}
          {/* Configure goes to the detail page. The detail page is
              the "settings" surface for every item type -- sharing,
              metadata, schema / layer config, replace data, etc. --
              and the user's role gates what's editable inside, so
              the same label works for admins and viewers alike. */}
          <a
            role="menuitem"
            href={configureHref}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            className={`flex items-center gap-2 px-3 py-2 text-ink-1 hover:bg-surface-2 ${
              isRunnable ? 'border-t border-border' : ''
            }`}
          >
            <Settings className="h-3.5 w-3.5 text-muted" />
            <span className="flex-1">{t('itemMenu.configure')}</span>
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
              <span className="flex-1">{t('itemMenu.previewData')}</span>
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
              <span className="flex-1">{t('items.share')}</span>
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
              <span className="flex-1">{t('itemMenu.moveToFolder')}</span>
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
                  ? t('itemMenu.removeFromNamedFolder', { folder: folderTitle })
                  : t('itemMenu.removeFromFolder')}
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
              <span className="flex-1">{t('items.moveToTrash')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
