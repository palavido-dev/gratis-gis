'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Folder as FolderIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { FolderRail, type FolderRailNode } from './folder-rail';

/**
 * Wraps the items-page folder rail in a togglable side drawer (#201).
 *
 * The original layout planted FolderRail as an always-visible left
 * column. As folder counts grew the rail competed for attention with
 * the My/All tabs, the filter chip strip, and the table toolbar -- a
 * lot of filtering surfaces in a small viewport. This wrapper hides
 * the rail by default behind a single toggle button. Clicking the
 * button opens the rail beside the content (push, not overlay) so the
 * grid remains visible and drag-drop into the rail (#43) keeps
 * working when the drawer is open.
 *
 * Open / closed state persists to localStorage keyed by
 * `gratisgis:items-folders-open` so a user's preference survives
 * across page loads. New users default to closed (cleaner first
 * impression); the only entry point to the drawer is the toggle, so
 * folders are still one click away.
 */
const STORAGE_KEY = 'gratisgis:items-folders-open';

interface Props {
  folders: FolderRailNode[];
  activeFolderId?: string;
  children: React.ReactNode;
}

export function FoldersDrawer({ folders, activeFolderId, children }: Props) {
  // Hydration-safe initial state. We can't read localStorage during
  // SSR; render closed on first mount and let the effect open the
  // drawer if the user previously had it open. The flicker is
  // minimal (the rail just slides in on first mount when restoring)
  // and avoids a hydration mismatch.
  const [open, setOpen] = useState(false);
  // ?folders=open in the URL forces the drawer open on land. The
  // sidebar's "Folders" link uses this so a user clicking Folders
  // actually sees the rail tree, regardless of their last
  // localStorage preference. Already-active inside-folder views
  // (?folder=<id>) also imply the drawer should be open: the user
  // is browsing inside a specific folder and the rail is the
  // primary nav surface for that view.
  const searchParams = useSearchParams();
  const wantOpenFromUrl =
    searchParams?.get('folders') === 'open' ||
    !!searchParams?.get('folder');

  useEffect(() => {
    if (wantOpenFromUrl) {
      setOpen(true);
      return;
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'true') setOpen(true);
    } catch {
      /* localStorage may be blocked (Safari private mode); just
         leave the drawer closed and let the user toggle it manually.
         Their preference won't persist across reloads but the page
         still works. */
    }
    // wantOpenFromUrl flips at most once per mount (URL doesn't
    // change without a navigate); listing it here keeps the eslint
    // exhaustive-deps check happy without thrashing the effect.
  }, [wantOpenFromUrl]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      /* swallow: same rationale as above */
    }
  }, [open]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${
            open
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
          }`}
          aria-expanded={open}
          aria-controls="items-folders-drawer"
        >
          {open ? (
            <PanelLeftClose className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftOpen className="h-3.5 w-3.5" />
          )}
          <FolderIcon className="h-3.5 w-3.5" />
          {open ? 'Hide folders' : 'Folders'}
          {folders.length > 0 ? (
            <span className="rounded bg-surface-0 px-1 text-[10px] text-muted">
              {folders.length}
            </span>
          ) : null}
        </button>
      </div>
      <div
        id="items-folders-drawer"
        className="flex flex-col gap-6 md:flex-row"
      >
        {open ? (
          <FolderRail folders={folders} activeFolderId={activeFolderId} />
        ) : null}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
