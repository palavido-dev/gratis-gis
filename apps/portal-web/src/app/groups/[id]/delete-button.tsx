// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { parseApiError } from '@/lib/api-error';

interface Props {
  groupId: string;
  groupTitle: string;
  /** How long groups stay in the trash before automatic purge. */
  retentionDays?: number;
}

/**
 * Soft-delete a group. Existing item shares that target this group will
 * stop granting access while it's trashed; restoring the group brings
 * those shares back to life. See docs/soft-delete.md.
 */
export function DeleteGroupButton({ groupId, groupTitle, retentionDays = 30 }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setError(null);
    const res = await fetch(`/api/portal/groups/${groupId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(await parseApiError(res, 'Delete failed'));
      return;
    }
    setOpen(false);
    router.push('/groups');
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
        title={`Move "${groupTitle}" to trash?`}
        description={`Members will lose access to items shared through this group. You can restore the group and all of its shares within ${retentionDays} days; after that it is permanently deleted.`}
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
