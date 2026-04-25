'use client';

import { useMemo, useState } from 'react';
import { Folder as FolderIcon, X } from 'lucide-react';
import type { FolderRailNode } from './folder-rail';

interface Props {
  /** Folder UUIDs the caller can edit; we filter the rail set down
   *  to this list before rendering the picker. Caller passes only
   *  manageable folders. */
  folders: FolderRailNode[];
  /** Item ids the user wants to add. */
  itemIds: string[];
  saving: boolean;
  /** Returns the folder id picked. */
  onSubmit: (folderId: string) => void;
  onClose: () => void;
}

/**
 * Modal "Add to folder" picker fired from the bulk-action bar on
 * the items page. Keeps the picker simple: a flat searchable list
 * of folders the caller can edit. A subsequent slice can render the
 * folders as a tree if the flat list gets unwieldy.
 *
 * The dialog does not perform the save itself; the parent's onSubmit
 * fetches the folder, appends the item ids, and PATCHes. That keeps
 * dialog state focused on selection / search and avoids re-doing the
 * cycle / authz checks that the API already runs.
 *
 * See docs/folders.md.
 */
export function AddToFolderDialog({
  folders,
  itemIds,
  saving,
  onSubmit,
  onClose,
}: Props) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return folders;
    return folders.filter((f) => f.title.toLowerCase().includes(needle));
  }, [folders, q]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (!saving && e.currentTarget === e.target) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface-1 shadow-raised">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderIcon className="h-4 w-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-ink-1">
              Add {itemIds.length} {itemIds.length === 1 ? 'item' : 'items'} to a folder
            </h2>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-1 disabled:cursor-not-allowed"
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search folders"
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            autoFocus
          />
          <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border bg-surface-2">
            {visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted">
                No folders match.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((f) => (
                  <li key={f.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-surface-1 ${
                        picked === f.id ? 'bg-accent/10' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="folder-pick"
                        checked={picked === f.id}
                        onChange={() => setPicked(f.id)}
                        className="h-3.5 w-3.5"
                      />
                      <FolderIcon className="h-4 w-4 shrink-0 text-amber-700" />
                      <span className="truncate">{f.title}</span>
                      <span className="ml-auto text-[11px] text-muted">
                        {f.childItemIds.length} items
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
          <button
            type="button"
            onClick={() => !saving && onClose()}
            disabled={saving}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => picked && onSubmit(picked)}
            disabled={!picked || saving}
            className="inline-flex h-8 items-center rounded-md border border-accent bg-accent px-3 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Adding...' : 'Add to folder'}
          </button>
        </div>
      </div>
    </div>
  );
}