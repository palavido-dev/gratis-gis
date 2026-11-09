// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DependentsWarning } from '@/components/dependents-warning';
import { parseApiError } from '@/lib/api-error';

interface Props {
  itemId: string;
  itemTitle: string;
  /** Type of the item being deleted. Folder items get a cascade
   *  preview (#156); other types use the default flow. */
  itemType?: string;
  /** How long items stay in the trash before automatic purge. */
  retentionDays?: number;
}

/** Cascade-delete preview returned by GET /items/:id/delete-cascade.
 *  Mirrors the FolderDeleteCascadePreview shape on the API side. */
interface CascadePreview {
  folders: Array<{ id: string; title: string }>;
  unlinkedItemCount: number;
}

/**
 * Soft-delete action. This moves the item to the trash, where it remains
 * recoverable for the retention window before an automated job purges it.
 * Because the action is reversible, we don't require typed-name
 * confirmation anymore: a simple confirm is enough friction.
 *
 * For folder items (#156): before opening the confirm dialog we
 * fetch the cascade preview so the user can see which subfolders
 * will be soft-deleted alongside the parent. The cascade preview
 * is non-empty only when the folder has subfolders whose only
 * non-trashed parent is this folder (i.e. they would be orphaned
 * by the delete). Subfolders that are also filed under another
 * parent are NOT listed because they will survive the delete.
 */
export function DeleteItemButton({
  itemId,
  itemTitle,
  itemType,
  retentionDays = 30,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // When the dialog opens for a folder, fetch the cascade preview.
  // Non-folder items get cascade=null and the dialog renders its
  // usual content unchanged.
  useEffect(() => {
    if (!open || itemType !== 'folder') {
      setCascade(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${itemId}/delete-cascade`,
        );
        if (!res.ok) {
          // Preview failure is non-fatal -- fall through to the
          // delete attempt; the api itself will refuse with a 409
          // if cascade is required, which we handle in doDelete.
          if (!cancelled) setCascade(null);
          return;
        }
        const body = (await res.json()) as CascadePreview;
        if (!cancelled) setCascade(body);
      } catch {
        if (!cancelled) setCascade(null);
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, itemType, itemId]);

  async function doDelete() {
    setError(null);
    // Cascade=true when the preview surfaced any orphaned
    // subfolders; the user has implicitly acknowledged the
    // cascade by clicking the confirm button after seeing the
    // list. For non-folder items or empty-cascade folders the
    // flag is omitted so the api takes the original code path.
    const needsCascade =
      itemType === 'folder' && (cascade?.folders.length ?? 0) > 0;
    const url = needsCascade
      ? `/api/portal/items/${itemId}?cascade=true`
      : `/api/portal/items/${itemId}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      // 409 means the api wants a cascade ack -- if the user got
      // here without the flag (e.g. preview fetch failed) read
      // the cascade preview out of the response body and re-
      // prompt rather than just showing the raw error.
      if (res.status === 409 && itemType === 'folder') {
        try {
          const body = (await res.json()) as {
            cascade?: CascadePreview;
            message?: string;
          };
          if (body.cascade) {
            setCascade(body.cascade);
            setError(
              'This folder contains subfolders. Click "Move to trash" again to confirm the cascade.',
            );
            return;
          }
        } catch {
          /* fall through to generic error */
        }
      }
      setError(await parseApiError(res, 'Delete failed'));
      return;
    }
    setOpen(false);
    router.push('/items');
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-danger shadow-card hover:bg-danger/5"
      >
        <Trash2 className="h-4 w-4" />
        Move to trash
      </button>
      <ConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={doDelete}
        title={`Move "${itemTitle}" to trash?`}
        description={`The item will stop appearing in lists and searches and every share attached to it will stop granting access. You can restore it from Trash within ${retentionDays} days; after that it is permanently deleted.`}
        confirmLabel="Move to trash"
      >
        {open ? (
          <>
            {/* Surface anything that references this item so the user
                isn't surprised when (e.g.) a map loses one of its
                layers after the trash. (#78) */}
            <DependentsWarning itemIds={[itemId]} />
            {/* Folder-cascade preview (#156). Only renders when
                this is a folder AND the preview returned at least
                one subfolder; otherwise the standard "Move to
                trash?" copy is sufficient. */}
            {itemType === 'folder' && previewing ? (
              <p className="mt-3 text-xs text-muted">
                Checking subfolders...
              </p>
            ) : null}
            {itemType === 'folder' &&
            cascade &&
            cascade.folders.length > 0 ? (
              <div className="mt-3 rounded-md border border-danger/40 bg-danger/5 p-3 text-xs">
                <p className="font-medium text-ink-0">
                  {cascade.folders.length === 1
                    ? '1 subfolder will also be moved to trash:'
                    : `${cascade.folders.length} subfolders will also be moved to trash:`}
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-1">
                  {cascade.folders.slice(0, 12).map((f) => (
                    <li key={f.id}>{f.title}</li>
                  ))}
                  {cascade.folders.length > 12 ? (
                    <li className="text-muted">
                      ...and {cascade.folders.length - 12} more.
                    </li>
                  ) : null}
                </ul>
                {cascade.unlinkedItemCount > 0 ? (
                  <p className="mt-2 text-muted">
                    {cascade.unlinkedItemCount === 1
                      ? '1 other item inside these folders will lose its folder reference, but the item itself stays.'
                      : `${cascade.unlinkedItemCount} other items inside these folders will lose their folder reference, but the items themselves stay.`}
                  </p>
                ) : null}
                <p className="mt-2 text-muted">
                  Subfolders that are also filed under another folder
                  will survive this delete and aren&rsquo;t listed.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
