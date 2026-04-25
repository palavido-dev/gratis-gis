'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  FolderPlus,
  MoreVertical,
  Share2,
  Trash2,
} from 'lucide-react';

/**
 * Right-click + kebab menu attached to a folder row in the FolderRail.
 * Same items either way so keyboard / trackpad users without
 * secondary-click still get the affordance.
 *
 * Items:
 *   - Open details        -> /items/<folderId>
 *   - Share...            -> /items/<folderId>#sharing
 *   - New subfolder       -> /items/new?type=folder&parentFolderId=<folderId>
 *   - Move to trash       -> DELETE /api/portal/items/<folderId>
 *
 * Trash is gated by canEdit; everything else is always visible.
 */
interface Props {
  folderId: string;
  folderTitle: string;
  canEdit: boolean;
}

export function FolderRowMenu({ folderId, folderTitle, canEdit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  // Close on outside click / escape so the menu doesn't linger.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
        setPos(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setPos(null);
      }
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function openAtPos(x: number, y: number) {
    setPos({ x, y });
    setOpen(true);
  }

  async function moveToTrash() {
    if (!canEdit) return;
    if (
      !window.confirm(
        `Move "${folderTitle}" to the recycle bin? The folder's contents stay where they are; only the folder arrangement is removed.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/items/${folderId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        window.alert(`Move to trash failed: ${res.status}`);
        return;
      }
      setOpen(false);
      setPos(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
          openAtPos(rect.right, rect.bottom);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openAtPos(e.clientX, e.clientY);
        }}
        aria-label={`Actions for ${folderTitle}`}
        title="More actions"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-1 hover:text-ink-1"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {/* Right-click anywhere on the row also opens the menu; the
          parent FolderNode wires onContextMenu to this same handler
          via the imperative API below. */}

      {open && pos ? (
        <div
          role="menu"
          aria-label={`Actions for ${folderTitle}`}
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            zIndex: 50,
          }}
          className="min-w-[200px] overflow-hidden rounded-md border border-border bg-surface-1 py-1 text-sm shadow-raised"
        >
          <Link
            href={`/items/${folderId}`}
            onClick={() => {
              setOpen(false);
              setPos(null);
            }}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted" />
            Open details
          </Link>
          <Link
            href={`/items/${folderId}#sharing`}
            onClick={() => {
              setOpen(false);
              setPos(null);
            }}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
          >
            <Share2 className="h-3.5 w-3.5 text-muted" />
            Share...
          </Link>
          <Link
            href={`/items/new?type=folder&parentFolderId=${folderId}`}
            onClick={() => {
              setOpen(false);
              setPos(null);
            }}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
          >
            <FolderPlus className="h-3.5 w-3.5 text-muted" />
            New subfolder
          </Link>
          {canEdit ? (
            <>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={moveToTrash}
                disabled={busy}
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {busy ? 'Trashing...' : 'Move to trash'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}