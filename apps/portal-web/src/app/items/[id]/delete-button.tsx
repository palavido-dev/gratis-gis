'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface Props {
  itemId: string;
  itemTitle: string;
  /** How long items stay in the trash before automatic purge. */
  retentionDays?: number;
}

/**
 * Soft-delete action. This moves the item to the trash, where it remains
 * recoverable for the retention window before an automated job purges it.
 * Because the action is reversible, we don't require typed-name
 * confirmation anymore: a simple confirm is enough friction.
 */
export function DeleteItemButton({ itemId, itemTitle, retentionDays = 30 }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setError(null);
    const res = await fetch(`/api/portal/items/${itemId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(`Delete failed: ${res.status} ${await res.text()}`);
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
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
