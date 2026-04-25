'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FolderPlus, Inbox, Plus, X } from 'lucide-react';
import { ItemCard } from '@gratis-gis/ui';
import type { FolderData, ItemWithShares } from '@gratis-gis/shared-types';
import { DEFAULT_FOLDER } from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';

interface Props {
  itemId: string;
  initial: FolderData;
  /** Pre-resolved children, in the folder's authoritative order. */
  initialChildren: ItemWithShares[];
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
  canEdit,
  canCreate,
}: Props) {
  const router = useRouter();
  const [children, setChildren] = useState<ItemWithShares[]>(initialChildren);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const childIds = useMemo(
    () => initial.childItemIds.filter(Boolean),
    [initial.childItemIds],
  );
  const visibleCount = children.length;
  const totalRefs = childIds.length;

  async function removeFromFolder(childId: string) {
    setError(null);
    setRemoving((prev) => new Set(prev).add(childId));
    try {
      const next: FolderData = {
        ...initial,
        childItemIds: initial.childItemIds.filter(
          (id: string) => id !== childId,
        ),
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

  return (
    <section className="space-y-4">
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {children.map((child) => {
            const Icon = getItemTypeIcon(child.type);
            const accent = getItemTypeAccent(child.type);
            const busy = removing.has(child.id);
            return (
              <div key={child.id} className="group relative">
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeFromFolder(child.id)}
                    disabled={busy}
                    aria-label={`Remove ${child.title} from this folder`}
                    title="Remove from this folder (does not delete the item)"
                    className="absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1/95 text-muted opacity-0 backdrop-blur transition-opacity hover:bg-surface-2 hover:text-ink-1 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? (
                      <span className="text-[9px]">...</span>
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                  </button>
                ) : null}
                <ItemCard
                  item={child}
                  href={`/items/${child.id}`}
                  fallbackIcon={<Icon />}
                  headerExtra={
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide ${accent}`}
                    >
                      <Icon className="h-3 w-3" />
                      {getItemTypeLabel(child.type)}
                    </span>
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// DEFAULT_FOLDER pulled at the import site so the bundler keeps the
// module-load path identical to the wizard's shape on first paint.
export const _FolderDetailDefaults = DEFAULT_FOLDER;